# kappa-osm

> Peer-to-peer OpenStreetMap database over [kappa-core](https://github.com/noffle/kappa-core)

## Purpose

A simple and easy-to-use geographic/spatial database that works offline, and
can synchronize with other instances of the database using a variety of
methods, internet and non (local wifi, USB keys, bluetooth, and more).

## Current Status

*MOSTLY STABLE*

Several upstream modules are using this now, and are being integrated into "real" apps. Expect minimal breaking changes going forward.

If you're interested in this project, leave an issue and share a bit about what
you're building & how we might collaborate!

## Usage

```js
var kappa = require('kappa-core')
var ram = require('random-access-memory')
var memdb = require('memdb')
var Osm = require('kappa-osm')

var osm = Osm({
  core: kappa(ram, { valueEncoding: 'json' }),
  index: memdb(),
  storage: function (name, cb) { cb(null, ram()) }
})

var node = {
  type: 'node',
  lat: '-12.7',
  lon: '1.3',
  tags: { feature: 'water fountain' },
  changeset: 'abcdef'
}

osm.create(node, function (err, node) {
  if (err) return console.error(err)

  console.log('created node with id', node.id)

  osm.query([1,-13,2,-11], function (err, nodes) {
    if (err) console.error(err)
    else console.log(nodes)
  })
})
```

outputs

```
created node with id 58261217205dc19b
[
  {
    id: '58261217205dc19b',
    type: 'node',
    lat: '-12.7',
    lon: '1.3',
    tags: { feature: 'water fountain' },
    changeset: 'abcdef' },
    version: '366212350b5996f944df9df25e679a98545bdac98f507a06f493d167ff9d5f14@0',
    links: [],
    deviceId: '366212350b5996f944df9df25e679a98545bdac98f507a06f493d167ff9d5f14',
    authorId: '366212350b5996f944df9df25e679a98545bdac98f507a06f493d167ff9d5f14'
  }
]
```

## API

```js
var Osm = require('kappa-osm')
```

### var osm = Osm(opts)

Expected `opts` include:

- `core`: a [kappa-core](https://github.com/noffle/kappa-core) instance
- `index`: a [levelup](https://github.com/level/levelup) instance
- `storage`: a `function (name, cb) {}` that should provide a
  [random-access-storage](https://github.com/random-access-storage) instance to
  its callback `cb`

### osm.create(element, cb)

Create the new OSM element `element` and add it to the database. The resulting
element, populated with the `id`, `version`, and `authorId`, and `deviceId` fields, is returned
by the callback `cb`.

`authorId` is the original author's deviceId, while `deviceId` represents the device
that most recently edited the element.

### osm.get(id, cb)

Fetch all of the newest OSM elements with the ID `id`. `cb` is called with an
array of OSM elements.

The reason an array is returned is because of the distributed nature of the
database: in the case that multiple peers modify an element prior to sync'ing
their databases with each other, there would be multiple latest elements
("heads") for that ID.

If no elements with `id` exist, an empty array is returned.

### osm.getByVersion(version[, opts], cb)

Fetch a specific OSM element by its version string. Returns `null` if not found,
otherwise the single element.

### osm.put(id, element, [opts, ]cb)

Update an existing element with ID `id` to be the OSM element `element`. The new
element should have all fields that the OSM element would have. The `type` of
the element cannot be changed.

Updates work by replacing old heads (latest versions) with a new version. This
works by "linking" back to the version names of all previous heads you want to
replace. This happens automatically, but if an array of versions are passed
into `opts.links`, those elements will be replaced with this newer version
instead of the default current heads.

`cb` is called with the new element, including `id`, `version`, and `deviceId`
properties.

### osm.del(id, value, cb)

Marks the element `id` as deleted. Since all data is append-only in the
database, this does not actually delete data, but instead writes a brand new
version of the document with `{ deleted: true }` set on it.

Deleted ways, nodes, and relations are all still returned by the `query` API.
The nodes of a deleted way are not included in the results.

### osm.batch(ops, cb)

Create and update many elements atomically. `ops` is an array of operations
(objects) describing the elements to be added or updated or deleted.

```js
{
  type: 'put|del',
  id: 'id',
  value: { /* element */ }
}
```

If no `id` field is set, the element is created, otherwise it is updated with
the element `value`.

An operation type of `'put'` inserts a new element or modifies an existing one,
while a type of`'del'` will mark the element as deleted.

Currently, doing a batch insert skips many validation checks in order to be as
fast as possible.

*TODO: means to enable validation + error reporting / atomic write*

### var rs = osm.query(bbox[, opts] [, cb])

Retrieves all nodes, ways, and relations within the bounding box `bbox`.

`bbox` is expected to be an array of the form `[WEST, SOUTH, EAST, NORTH]`.
Latitude (north/south) runs between `(-85, 85)`, and longitude (west/east)
between `(-180, 180)`.

A callback parameter `cb` is optional. If given, it will be called as `cb(err,
elements)`. If not provided, a Readable stream will be returned that can be
read from as elements are emitted. The distinction between the two is that the
callback will buffer all results before they are returned, but the stream will
emit results as they arrive, resulting in much less buffering. This can make a
large impact on memory use for queries on large datasets.

Elements are returned as governed by the [query algorithm outlined by the OSM v0.6 API](https://wiki.openstreetmap.org/wiki/API_v0.6#Retrieving_map_data_by_bounding_box:_GET_.2Fapi.2F0.6.2Fmap):

1. All nodes that are inside a given bounding box and any relations that
   reference them.
2. All ways that reference at least one node that is inside a given bounding
   box, any relations that reference them (the ways), and any nodes outside the
   bounding box that the ways may reference.
3. All relations that reference one of the nodes, ways or relations included due
   to the above rules. (This does not apply recursively; meaning that elements
   referenced by a relation are not returned by virtue of being in that
   relation.)
4. All observations within the bounding box. An observation is a Mapeo point,
   so this may not be relevant to you if you aren't using Mapeo.

### var rs = osm.refs(id[, cb])

Fetch a list of all OSM elements that refer to the element with ID `id`. This
captures

1. elements with a `changeset` field
2. all nodes referenced by a way's `nodes` field
3. all nodes, ways, and relations referenced by a relation's `members` field

**TODO**: this could be made clearer -- maybe an example?

A callback parameter `cb` is optional. If given, it will be called as `cb(err,
results)`. If not provided or set to `null`, a Readable stream will be returned
that can be read from as results are ready.

Objects of the following form are returned:

```js
{
  id: '...',
  version: '...'
}
```

### var r = osm.history(opts)

Return a readable stream `r` of all the documents in the db sorted by
`timestamp` or `created_at` (for observations). By default, returns least recent
documents first.

The following options are accepted via the `opts` parameter:

* `opts.type`(boolean)  - additionally filter results by type as a string
* `opts.id` (boolean) - only show results for a single string id
* `opts.reverse` (boolean) - when `true`, provide results from most to least recent
* `opts.lt`, `opts.lte`, `opts.gt`, `opts.gte` (string) - lexicographic sorting options

**TODO**: clarify how lt/lte/gt/gte work

There is a separate index for filtering by type and ID each, so queries should
be fast. *Filtering by ID or type are exclusive options.*

The lexicographic sorting options operate on `timestamp`/`created_at` keys which
are in ISO 8601 format, as you could get from `.toISOString()`:

```
> new Date().toISOString()
'2018-09-14T23:07:53.862Z'
```

### var t = osm.byType(type)

Returns a readable stream `t` of all documents in the database of type `type`. Only the latest documents are returned, not historic data.

### var stream = osm.replicate(isInitiator, [opts])

Create a duplex replication stream, that you can pipe into another kappa-osm's
instance's replication stream. The stream ends once all map data is exchanged
between the two peers.

Ensure that `isInitiator` to `true` to one side, and `false` on the other.

`opts` are passed in to [multifeed](https://github.com/noffle/multifeed)'s API
of the same name.

### osm.on('error', function (err) {})

Event emitted when an error within kappa-osm has occurred. This is very
important to listen on, lest things suddenly seem to break and it's not
immediately clear why.

## Architecture

### Document Format

Documents (OSM elements, observations, etc) have a common format:

```js
  {
    id: String,
    type: String,
    lat: String,
    lon: String,
    tags: Object,
    changeset: String,
    links: Array<String>,
    version: String,
    deviceId: String,
    authorId: String
  }
```

*Note: `authorId` is the original author's deviceId, while `deviceId` represents the device
that most recently edited the element.*

**TODO**: talk about forking data & forking architecture*

## Install

With [npm](https://npmjs.org/) installed, run

```
$ npm install kappa-osm
```

## License

ISC

