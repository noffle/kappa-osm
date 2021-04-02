module.exports = Osm

var sub = require('subleveldown')
var utils = require('./lib/utils')
var once = require('once')
var uniq = require('uniq')
var EventEmitter = require('events').EventEmitter
var through = require('through2')
var pumpify = require('pumpify')
var clone = require('clone')

var umkv = require('unordered-materialized-kv')
var checkElement = require('./lib/check-element')
var createRefsIndex = require('./lib/refs-index.js')
var createChangesetIndex = require('./lib/changeset-index.js')
var createTypesIndex = require('./lib/types-index.js')
var createKvIndex = require('./lib/kv-index.js')
var createBkdIndex = require('./lib/bkd-index.js')
var createHistoryIndex = require('./lib/history-index.js')
var createAuthorIndex = require('./lib/author-index.js')

function Osm (opts) {
  if (!(this instanceof Osm)) return new Osm(opts)
  if (!opts.core) throw new Error('missing param "core"')
  if (!opts.index) throw new Error('missing param "index"')
  if (!opts.storage) throw new Error('missing param "storage"')

  var self = this

  this.core = opts.core
  this.core.on('error', function (err) {
    self.emit('error', err)
  })
  this.index = opts.index
  this.index.on('error', function (err) {
    self.emit('error', err)
  })

  this.writer = null
  this.readyFns = []
  this.core.writer('default', function (err, writer) {
    if (err) return self.emit('error', err)
    self.writer = writer
    self.readyFns.forEach(function (fn) { fn() })
    self.readyFns = []
  })

  // Create indexes
  var kv = umkv(sub(this.index, 'kvu'))
  var bkd = createBkdIndex(this.core, sub(this.index, 'bkd'), kv, opts.storage)
  this.core.use('kv', 2, createKvIndex(kv, sub(this.index, 'kvi')))
  this.core.use('refs', 2, createRefsIndex(sub(this.index, 'refs')))
  this.core.use('changeset', 2, createChangesetIndex(sub(this.index, 'ch')))
  this.core.use('geo', 2, bkd)
  this.core.use('history', 2, createHistoryIndex(this, sub(this.index, 'h')))
  this.core.use('types', 2, createTypesIndex(sub(this.index, 't')))
  this.core.use('author', 2, createAuthorIndex(sub(this.index, 'a')))
}
Osm.prototype = Object.create(EventEmitter.prototype)

// Is the log ready for writing?
Osm.prototype._ready = function (cb) {
  if (this.writer) cb()
  else this.readyFns.push(cb)
}

Osm.prototype.ready = function (cb) {
  // TODO: one day we'll have a readonly mode!
  if (!this.writer) {
    this.readyFns.push(cb)
    return
  }
  this.core.ready(cb)
}

// OsmElement -> Error
Osm.prototype.create = function (element, cb) {
  // Generate unique ID for element
  var id = utils.generateId()

  this.put(id, element, cb)
}

Osm.prototype._getAuthor = function (id, cb) {
  this.core.api.author.get(id, cb)
}

// OsmId -> [OsmElement]
Osm.prototype.get = function (id, cb) {
  var self = this

  var elms = []
  var error
  var pending = 0

  this.core.api.kv.get(id, function (err, versions) {
    if (err) return cb(err)
    versions = versions || []
    pending = versions.length + 1

    for (var i = 0; i < versions.length; i++) {
      self.getByVersion(versions[i], done)
    }
    done()
  })

  function done (err, elm) {
    if (err) error = err
    if (elm) elms.push(elm)
    if (--pending) return
    if (error) cb(error)
    else cb(null, elms)
  }
}

// String -> [Message]
Osm.prototype._getByVersion = function (version, cb) {
  var key = version.split('@')[0]
  var seq = version.split('@')[1]
  var feed = this.core._logs.feed(key)
  if (feed) {
    feed.get(seq, { wait:false }, cb)
  } else {
    process.nextTick(cb, null, null)
  }
}

// OsmVersion -> [OsmElement]
Osm.prototype.getByVersion = function (version, opts, cb) {
  var self = this
  if (typeof opts === 'function' && !cb) {
    cb = opts
    opts = {}
  }

  this._getByVersion(version, function (err, doc) {
    if (err) return cb(err)
    if (!doc) return cb(null, null)
    self._getAuthor(doc.id, function (err, authorId) {
      if (err) return cb(err)
      doc = Object.assign({}, doc, {
        version: version,
        deviceId: versionToDeviceId(version),
        authorId
      })
      cb(null, doc)
    })
  })
}

// OsmId, OsmElement -> OsmElement
Osm.prototype.put = function (id, element, opts, cb) {
  if (opts && !cb && typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  opts = opts || {}

  var self = this

  // Check for type errors
  var errs = checkElement(element, 'put')
  if (errs.length) return cb(errs[0])

  var doc = Object.assign({}, element, { id: id, timestamp: new Date().toISOString() })

  // set links
  if (opts.links) {
    doc.links = opts.links
    write()
  } else {
    self.core.api.kv.get(id, function (err, versions) {
      if (err) return cb(err)
      doc.links = versions
      write()
    })
  }

  // write to the feed
  function write () {
    self._ready(function () {
      self.writer.append(doc, function (err) {
        if (err) return cb(err)
        var version = self.writer.key.toString('hex') +
          '@' + (self.writer.length - 1)
        var deviceId = versionToDeviceId(version)
        var elm = Object.assign({}, doc, {
          version: version,
          deviceId: deviceId,
          id: id,
          authorId: deviceId,
          links: doc.links || []
        })
        cb(null, elm)
      })
    })
  }
}

// OsmId, OsmElement -> OsmElement
Osm.prototype.del = function (id, element, opts, cb) {
  if (opts && !cb && typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  opts = opts || {}

  var self = this

  // Check for type errors
  var errs = checkElement(element, 'del')
  if (errs.length) return cb(errs[0])

  getLinks(function (err, links) {
    if (err) return cb(err)
    getElms(links, function (err, elms) {
      if (err) return cb(err)
      if (!elms.length) return cb(new Error('no elements exist with id ' + id))
      var refs = self._mergeElementRefsAndMembers(elms)
      var doc = Object.assign({}, element, { id: id, deleted: true, type: elms[0].type, links: links })
      if (refs.refs) doc.refs = refs.refs
      else if (refs.members) doc.members = refs.members
      write(doc, cb)
    })
  })

  // Get links
  function getLinks (cb) {
    if (opts.links) {
      cb(null, opts.links)
    } else {
      self.core.api.kv.get(id, function (err, versions) {
        if (err) return cb(err)
        cb(null, versions)
      })
    }
  }

  function getElms (links, cb) {
    if (!links.length) return cb(null, [])

    var res = []
    var error
    var pending = links.length
    for (var i = 0; i < links.length; i++) {
      self.getByVersion(links[i], onElm)
    }

    function onElm (err, elm) {
      if (err) error = err
      else res.push(elm)
      if (--pending) return
      if (error) return cb(error)
      cb(null, res)
    }
  }

  // write to the feed
  function write (doc, cb) {
    self._ready(function () {
      doc.id = id
      self.writer.append(doc, function (err) {
        if (err) return cb(err)
        var version = self.writer.key.toString('hex') +
          '@' + (self.writer.length - 1)
        var elm = Object.assign({}, element, { id: id, version: version })
        cb(null, elm)
      })
    })
  }
}

// TODO: should element validation happen on batch jobs?
Osm.prototype.batch = function (ops, cb) {
  if (!ops || !ops.length) return cb()

  var self = this
  var mutOps = clone(ops)
  cb = once(cb)

  populateWayRelationRefs(function (err) {
    if (err) return cb(err)
    populateMissingLinks(function (err) {
      if (err) return cb(err)
      writeData(cb)
    })
  })

  // First, populate way & relation deletions with correct refs/members.
  function populateWayRelationRefs (cb) {
    var pending = 0
    var error
    for (var i = 0; i < mutOps.length; i++) {
      if (mutOps[i].type === 'del') {
        pending++
        updateRefs(mutOps[i].id, mutOps[i].value.links || [], mutOps[i].value, function (err) {
          if (err) error = err
          if (!--pending) cb(error)
        })
      }
    }
    if (!pending) cb()
  }

  function populateMissingLinks (cb) {
    var pending = 1
    for (var i = 0; i < mutOps.length; i++) {
      if (!mutOps[i].id) {
        mutOps[i].id = utils.generateId()
        mutOps[i].value.links = []
      } else if (!mutOps[i].value.links) {
        pending++
        ;(function get (op) {
          self.core.api.kv.get(op.id, function (err, versions) {
            op.value.links = versions || []
            if (!--pending) cb(err)
          })
        })(mutOps[i])
      }
    }
    if (!--pending) cb()
  }

  function writeData (cb) {
    var batch = mutOps.map(osmOpToMsg)

    self._ready(function () {
      var key = self.writer.key.toString('hex')
      var startSeq = self.writer.length
      self.writer.append(batch, function (err) {
        if (err) return cb(err)
        var res = batch.map(function (doc, n) {
          var version = key + '@' + (startSeq + n)
          return Object.assign({}, doc, {
            id: doc.id,
            version: version,
            deviceId: versionToDeviceId(version)
          })
        })
        cb(null, res)
      })
    })
  }

  function updateRefs (id, links, elm, cb) {
    if (links) self._getRefsMembersByVersions(links, done)
    else self._getRefsMembersById(id, done)

    function done (err, res) {
      if (err) return cb(err)
      if (res.refs) elm.refs = res.refs
      else if (res.members) elm.members = res.members
      cb()
    }
  }

  function osmOpToMsg (op) {
    if (op.type === 'put') {
      return Object.assign({}, op.value, { id: op.id })
    } else if (op.type === 'del') {
      return Object.assign({}, op.value, { id: op.id, deleted: true })
    } else {
      cb(new Error('unknown type'))
    }
  }
}

// Id -> { id, version }
Osm.prototype.getChanges = function (id, cb) {
  var self = this
  this.core.api.changeset.ready(function () {
    self.core.api.changeset.get(id, cb)
  })
}

// Id -> { id, version }
Osm.prototype.refs = function (id, cb) {
  var self = this
  this.core.api.refs.ready(function () {
    self.core.api.refs.get(id, cb)
  })
}

Osm.prototype.byType = function (type, opts) {
  opts = opts || {}
  var self = this

  var fetch = through.obj(function (row, _, next) {
    self._getByVersion(row.version, function (err, elm) {
      if (err) return next(err)
      if (!elm) return next()
      var res = Object.assign(elm, {
        version: row.version,
        deviceId: versionToDeviceId(row.version),
        id: row.id
      })
      next(null, res)
    })
  })

  var ropts = {}
  if (opts.limit) ropts.limit = opts.limit

  return pumpify.obj(this.core.api.types.createReadStream(type, ropts), fetch)
}

// BoundingBox -> (Stream or Callback)
Osm.prototype.query = function (bbox, opts, cb) {
  if (opts && !cb && typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  opts = opts || {}

  var filter = through.obj(function (row, _, next) {
    if (!row || !row.type) return next()
    const type = row.type
    if (type !== 'node' && type !== 'way' && type !== 'relation' && type !== 'observation') return next()
    next(null, row)
  })

  var stream = this.core.api.geo.query(bbox, opts, cb)
  if (stream instanceof Error) return process.nextTick(stream)
  var res = pumpify.obj(stream, filter)

  return res
}

Osm.prototype.createReplicationStream = function (isInitiator, opts) {
  return this.core.replicate(isInitiator, opts)
}
Osm.prototype.replicate = Osm.prototype.createReplicationStream

// OsmId -> {refs: [OsmId]} | {members: [OsmId]} | {}
Osm.prototype._mergeElementRefsAndMembers = function (elms) {
  var res = {}
  for (var i = 0; i < elms.length; i++) {
    var elm = elms[i]
    if (elm.refs) {
      res.refs = res.refs || []
      mergeRefs(res.refs, elm.refs)
    } else if (elm.members) {
      res.members = res.members || []
      mergeMembers(res.members, elm.members)
    }
  }
  return res

  function mergeRefs (into, from) {
    into.push.apply(into, from)
    return uniq(into)
  }

  function mergeMembers (into, from) {
    into.push.apply(into, from)
    return uniq(into, memberCmp)
  }

  function memberCmp (a, b) {
    return a.id === b.id ? 0 : -1
  }
}

// OsmId -> {refs: [OsmId]} | {members: [OsmId]} | {}
Osm.prototype._getRefsMembersById = function (id, cb) {
  var self = this
  this.get(id, function (err, elms) {
    if (err || !elms || !elms.length) return cb(err, {})
    var res = self._mergeElementRefsAndMembers(elms)
    cb(null, res)
  })
}

// [OsmVersion] -> {refs: [OsmId]} | {members: [OsmId]} | {}
Osm.prototype._getRefsMembersByVersions = function (versions, cb) {
  var self = this
  if (!versions.length) return process.nextTick(cb, null, [])

  var elms = []
  var error
  var pending = versions.length
  for (var i = 0; i < versions.length; i++) {
    self.getByVersion(versions[i], onElm)
  }

  function onElm (err, elm) {
    if (err) error = err
    if (elm) elms.push(elm)
    if (--pending) return
    if (error) return cb(error)

    var res = self._mergeElementRefsAndMembers(elms)
    cb(null, res)
  }
}

Osm.prototype.history = function (opts) {
  if (opts && opts.id && opts.type) {
    var stream = through.obj()
    var err = new Error('id and type are exclusive history options')
    process.nextTick(function () {
      stream.emit('error', err)
    })
    return stream
  } else if (opts && opts.id) {
    return this.core.api.history.id(opts.id, opts)
  } else if (opts && opts.type) {
    return this.core.api.history.type(opts.type, opts)
  } else {
    return this.core.api.history.all(opts)
  }
}

function versionToDeviceId (version) {
  return version.split('@')[0]
}
