// @flow

import type Database, {BindingDictionary, Statement} from "better-sqlite3";
import stringify from "json-stable-stringify";

import dedent from "../util/dedent";
import * as Schema from "./schema";
import * as Queries from "./queries";

/**
 * A local mirror of a subset of a GraphQL database.
 */
/*
 * NOTE(perf): The implementation of this class is not particularly
 * optimized. In particular, when we interact with SQLite, we compile
 * our prepared statements many times over the lifespan of an
 * instance. It may be beneficial to precompile them at instance
 * construction time.
 */
export class Mirror {
  +_db: Database;
  +_schema: Schema.Schema;
  +_schemaInfo: SchemaInfo;

  /**
   * Create a GraphQL mirror using the given database connection and
   * GraphQL schema.
   *
   * The connection must be to a database that either (a) is empty and
   * unused, or (b) has been previously used for a GraphQL mirror with
   * an identical GraphQL schema. The database attached to the
   * connection must not be modified by any other clients. In other
   * words, passing a connection to this constructor entails transferring
   * ownership of the attached database to this module.
   *
   * If the database attached to the connection has been used with an
   * incompatible GraphQL schema or an outdated version of this module,
   * an error will be thrown and the database will remain unmodified.
   */
  constructor(db: Database, schema: Schema.Schema): void {
    if (db == null) throw new Error("db: " + String(db));
    if (schema == null) throw new Error("schema: " + String(schema));
    this._db = db;
    this._schema = schema;
    this._schemaInfo = _buildSchemaInfo(this._schema);
    this._initialize();
  }

  /**
   * Embed the GraphQL schema into the database, initializing it for use
   * as a mirror.
   *
   * This method should only be invoked once, at construction time.
   *
   * If the database has already been initialized with the same schema
   * and version, no action is taken and no error is thrown. If the
   * database has been initialized with a different schema or version,
   * the database is left unchanged, and an error is thrown.
   *
   * A discussion of the database structure follows.
   *
   * ---
   *
   * Objects have three kinds of fields: connections, links, and
   * primitives (plus an ID, which we ignore for now). The database has
   * a single `connections` table for all objects, and also a single
   * `links` table for all objects. For primitives, each GraphQL data
   * type has its own table, and each object of that type has a row in
   * the corresponding table.
   *
   * In more detail:
   *   - The `connections` table has a row for each `(id, fieldname)`
   *     pair, where `fieldname` is the name of a connection field on the
   *     object with the given ID. This stores metadata about the
   *     connection: its total count, when it was last updated, etc. It
   *     does not store the actual entries in the connection (the nodes
   *     that the connection points to); `connection_entries` stores
   *     these.
   *   - The `links` table has a row for each `(id, fieldname)` pair,
   *     where `fieldname` is the name of a link field on the object
   *     with the given ID. This simply points to the referenced object.
   *   - For each type `T`, the `primitives_T` table has one row for
   *     each object of type `T`, storing the primitive data of the
   *     object.
   *
   * We refer to node and primitive data together as "own data", because
   * this is the data that can be queried uniformly for all elements of
   * a type; querying connection data, by contrast, requires the
   * object-specific end cursor.
   *
   * All aforementioned tables are keyed by object ID. Each object also
   * appears once in the `objects` table, which relates its ID,
   * typename, and last own-data update. Each connection has its own
   * last-update value, because connections can be updated independently
   * of each other and of own-data.
   *
   * Note that any object in the database should have entries in the
   * `connections` and `links` table for all relevant fields, as well as
   * an entry in the relevant primitives table, even if the node has
   * never been updated. This is for convenience of implementation: it
   * means that the first fetch for a node is the same as subsequent
   * fetches (a SQL `UPDATE` instead of first requiring an existence
   * check).
   *
   * Finally, a table `meta` is used to store metadata about the mirror
   * itself. This is used to make sure that the mirror is not loaded
   * with an incompatible version of the code or schema. It is never
   * updated after it is first set.
   */
  _initialize() {
    // The following version number must be updated if there is any
    // change to the way in which a GraphQL schema is mapped to a SQL
    // schema or the way in which the resulting SQL schema is
    // interpreted. If you've made a change and you're not sure whether
    // it requires bumping the version, bump it: requiring some extra
    // one-time cache resets is okay; doing the wrong thing is not.
    const blob = stringify({version: "MIRROR_v1", schema: this._schema});
    const db = this._db;
    _inTransaction(db, () => {
      // We store the metadata in a singleton table `meta`, whose unique row
      // has primary key `0`. Only the first ever insert will succeed; we
      // are locked into the first schema.
      db.prepare(
        dedent`\
          CREATE TABLE IF NOT EXISTS meta (
              zero INTEGER PRIMARY KEY,
              schema TEXT NOT NULL
          )
        `
      ).run();

      const existingBlob: string | void = db
        .prepare("SELECT schema FROM meta")
        .pluck()
        .get();
      if (existingBlob === blob) {
        // Already set up; nothing to do.
        return;
      } else if (existingBlob !== undefined) {
        throw new Error(
          "Database already populated with incompatible schema or version"
        );
      }
      db.prepare("INSERT INTO meta (zero, schema) VALUES (0, ?)").run(blob);

      // First, create those tables that are independent of the schema.
      const structuralTables = [
        // Time is stored in milliseconds since 1970-01-01T00:00Z, with
        // ECMAScript semantics (leap seconds ignored, exactly 86.4M ms
        // per day, etc.).
        //
        // We use milliseconds rather than seconds because (a) this
        // simplifies JavaScript interop to a simple `+new Date()` and
        // `new Date(value)`, and (b) this avoids a lurking Year 2038
        // problem by surfacing >32-bit values immediately. (We have
        // over 200,000 years before the number of milliseconds since
        // epoch is more than `Number.MAX_SAFE_INTEGER`.)
        dedent`\
          CREATE TABLE updates (
              rowid INTEGER PRIMARY KEY,
              time_epoch_millis INTEGER NOT NULL
          )
        `,
        dedent`\
          CREATE TABLE objects (
              id TEXT NOT NULL PRIMARY KEY,
              typename TEXT NOT NULL,
              last_update INTEGER,
              FOREIGN KEY(last_update) REFERENCES updates(rowid)
          )
        `,
        dedent`\
          CREATE TABLE links (
              rowid INTEGER PRIMARY KEY,
              parent_id TEXT NOT NULL,
              fieldname TEXT NOT NULL,
              child_id TEXT,
              UNIQUE(parent_id, fieldname),
              FOREIGN KEY(parent_id) REFERENCES objects(id),
              FOREIGN KEY(child_id) REFERENCES objects(id)
          )
        `,
        dedent`\
          CREATE UNIQUE INDEX idx_links__parent_id__fieldname
          ON links (parent_id, fieldname)
        `,
        dedent`\
          CREATE TABLE connections (
              rowid INTEGER PRIMARY KEY,
              object_id TEXT NOT NULL,
              fieldname TEXT NOT NULL,
              last_update INTEGER,
              -- Each of the below fields must be NULL if the connection
              -- has never been updated.
              total_count INTEGER,
              has_next_page BOOLEAN,
              -- The end cursor may be NULL if no items are in the connection;
              -- this is a consequence of GraphQL and the Relay pagination spec.
              -- (It may also be NULL if the connection was never updated.)
              end_cursor TEXT,
              CHECK((last_update IS NULL) = (total_count IS NULL)),
              CHECK((last_update IS NULL) = (has_next_page IS NULL)),
              CHECK((last_update IS NULL) <= (end_cursor IS NULL)),
              UNIQUE(object_id, fieldname),
              FOREIGN KEY(object_id) REFERENCES objects(id),
              FOREIGN KEY(last_update) REFERENCES updates(rowid)
          )
        `,
        dedent`\
          CREATE UNIQUE INDEX idx_connections__object_id__fieldname
          ON connections (object_id, fieldname)
        `,
        dedent`\
          CREATE TABLE connection_entries (
              rowid INTEGER PRIMARY KEY,
              connection_id INTEGER NOT NULL,
              idx INTEGER NOT NULL,  -- impose an ordering
              child_id TEXT,
              UNIQUE(connection_id, idx),
              FOREIGN KEY(connection_id) REFERENCES connections(rowid),
              FOREIGN KEY(child_id) REFERENCES objects(id)
          )
        `,
        dedent`\
          CREATE INDEX idx_connection_entries__connection_id
          ON connection_entries (connection_id)
        `,
      ];
      for (const sql of structuralTables) {
        db.prepare(sql).run();
      }

      // Then, create primitive-data tables, which depend on the schema.
      // We only create tables for object types, as union types have no
      // physical representation; they exist only at the type level.
      for (const typename of Object.keys(this._schemaInfo.objectTypes)) {
        const type = this._schemaInfo.objectTypes[typename];
        if (!isSqlSafe(typename)) {
          throw new Error(
            "invalid object type name: " + JSON.stringify(typename)
          );
        }
        for (const fieldname of type.primitiveFieldNames) {
          if (!isSqlSafe(fieldname)) {
            throw new Error("invalid field name: " + JSON.stringify(fieldname));
          }
        }
        const tableName = _primitivesTableName(typename);
        const tableSpec = [
          "id TEXT NOT NULL PRIMARY KEY",
          ...type.primitiveFieldNames.map((fieldname) => `"${fieldname}"`),
          "FOREIGN KEY(id) REFERENCES objects(id)",
        ].join(", ");
        db.prepare(`CREATE TABLE ${tableName} (${tableSpec})`).run();
      }
    });
  }

  /**
   * Register a new update, representing one communication with the
   * remote server. A unique ID will be created and returned.
   */
  _createUpdate(updateTimestamp: Date): UpdateId {
    return this._db
      .prepare("INSERT INTO updates (time_epoch_millis) VALUES (?)")
      .run(+updateTimestamp).lastInsertROWID;
  }

  /**
   * Inform the GraphQL mirror of the existence of an object. The
   * object's name and concrete type must be specified. The concrete
   * type must be an OBJECT type in the GraphQL schema.
   *
   * If the object has previously been registered with the same type, no
   * action is taken and no error is raised. If the object has
   * previously been registered with a different type, an error is
   * thrown, and the database is left unchanged.
   */
  registerObject(object: {|
    +typename: Schema.Typename,
    +id: Schema.ObjectId,
  |}): void {
    _inTransaction(this._db, () => {
      this._nontransactionallyRegisterObject(object);
    });
  }

  /**
   * As `registerObject`, but do not enter any transactions. Other
   * methods may call this method as a subroutine in a larger
   * transaction.
   */
  _nontransactionallyRegisterObject(object: {|
    +typename: Schema.Typename,
    +id: Schema.ObjectId,
  |}): void {
    const db = this._db;
    const {typename, id} = object;

    const existingTypename = db
      .prepare("SELECT typename FROM objects WHERE id = ?")
      .pluck()
      .get(id);
    if (existingTypename === typename) {
      // Already registered; nothing to do.
      return;
    } else if (existingTypename !== undefined) {
      const s = JSON.stringify;
      throw new Error(
        `Inconsistent type for ID ${s(id)}: ` +
          `expected ${s(existingTypename)}, got ${s(typename)}`
      );
    }

    if (this._schema[typename] == null) {
      throw new Error("Unknown type: " + JSON.stringify(typename));
    }
    if (this._schema[typename].type !== "OBJECT") {
      throw new Error(
        "Cannot add object of non-object type: " +
          `${JSON.stringify(typename)} (${this._schema[typename].type})`
      );
    }

    this._db
      .prepare(
        dedent`\
          INSERT INTO objects (id, last_update, typename)
          VALUES (:id, NULL, :typename)
        `
      )
      .run({id, typename});
    this._db
      .prepare(
        dedent`\
          INSERT INTO ${_primitivesTableName(typename)} (id)
          VALUES (?)
        `
      )
      .run(id);
    const addLink = this._db.prepare(
      dedent`\
        INSERT INTO links (parent_id, fieldname, child_id)
        VALUES (:id, :fieldname, NULL)
      `
    );
    const addConnection = this._db.prepare(
      // These fields are initialized to NULL because there has
      // been no update and so they have no meaningful values:
      // last_update, total_count, has_next_page, end_cursor.
      dedent`\
        INSERT INTO connections (object_id, fieldname)
        VALUES (:id, :fieldname)
      `
    );
    const objectType = this._schemaInfo.objectTypes[typename];
    for (const fieldname of objectType.linkFieldNames) {
      addLink.run({id, fieldname});
    }
    for (const fieldname of objectType.connectionFieldNames) {
      addConnection.run({id, fieldname});
    }
  }

  /**
   * Register an object corresponding to the provided `NodeFieldResult`,
   * if any, returning the object's ID. If the provided value is `null`,
   * no action is taken, no error is thrown, and `null` is returned.
   *
   * As with `registerObject`, an error is thrown if an object by the
   * given ID already exists with a different typename.
   *
   * This method does not begin or end any transactions. Other methods
   * may call this method as a subroutine in a larger transaction.
   *
   * See: `registerObject`.
   */
  _nontransactionallyRegisterNodeFieldResult(
    result: NodeFieldResult
  ): Schema.ObjectId | null {
    if (result == null) {
      return null;
    } else {
      const object = {typename: result.__typename, id: result.id};
      this._nontransactionallyRegisterObject(object);
      return object.id;
    }
  }

  /**
   * Find objects and connections that are not known to be up-to-date.
   *
   * An object is up-to-date if its own data has been loaded at least as
   * recently as the provided date.
   *
   * A connection is up-to-date if it has been fetched at least as
   * recently as the provided date, and at the time of fetching there
   * were no more pages.
   */
  _findOutdated(since: Date): QueryPlan {
    const db = this._db;
    return _inTransaction(db, () => {
      const objects: $PropertyType<QueryPlan, "objects"> = db
        .prepare(
          dedent`\
            SELECT typename AS typename, id AS id
            FROM objects
            LEFT OUTER JOIN updates ON objects.last_update = updates.rowid
            WHERE objects.last_update IS NULL
            OR updates.time_epoch_millis < :timeEpochMillisThreshold
          `
        )
        .all({timeEpochMillisThreshold: +since});
      const connections: $PropertyType<QueryPlan, "connections"> = db
        .prepare(
          dedent`\
            SELECT
                connections.object_id AS objectId,
                connections.fieldname AS fieldname,
                connections.last_update IS NULL AS neverUpdated,
                connections.end_cursor AS endCursor
            FROM connections
            LEFT OUTER JOIN updates ON connections.last_update = updates.rowid
            WHERE connections.has_next_page
            OR connections.last_update IS NULL
            OR updates.time_epoch_millis < :timeEpochMillisThreshold
          `
        )
        .all({timeEpochMillisThreshold: +since})
        .map((entry) => {
          const result = {...entry};
          if (result.neverUpdated) {
            result.endCursor = undefined; // as opposed to `null`
          }
          delete result.neverUpdated;
          return result;
        });
      return {objects, connections};
    });
  }

  /**
   * Create a GraphQL selection set required to identify the typename
   * and ID for an object of the given declared type, which may be
   * either an object type or a union type. This is the minimal
   * whenever we find a reference to an object that we want to traverse
   * later.
   *
   * The resulting GraphQL should be embedded in the context of any node
   * of the provided type. For instance, `_queryShallow("Issue")`
   * returns a selection set that might replace the `?` in any of the
   * following queries:
   *
   *     repository(owner: "foo", name: "bar") {
   *       issues(first: 1) {
   *         nodes { ? }
   *       }
   *     }
   *
   *     nodes(ids: ["issue#1", "issue#2"]) { ? }
   *
   * The result of this query has type `NodeFieldResult`.
   *
   * This function is pure: it does not interact with the database.
   */
  _queryShallow(typename: Schema.Typename): Queries.Selection[] {
    const type = this._schema[typename];
    if (type == null) {
      // Should not be reachable via APIs.
      throw new Error("No such type: " + JSON.stringify(typename));
    }
    const b = Queries.build;
    switch (type.type) {
      case "OBJECT":
        return [b.field("__typename"), b.field("id")];
      case "UNION":
        return [
          b.field("__typename"),
          ...this._schemaInfo.unionTypes[typename].clauses.map(
            (clause: Schema.Typename) =>
              b.inlineFragment(clause, [b.field("id")])
          ),
        ];
      // istanbul ignore next
      default:
        throw new Error((type.type: empty));
    }
  }

  /**
   * Get the current value of the end cursor on a connection, or
   * `undefined` if the object has never been fetched. If no object by
   * the given ID is known, or the object does not have a connection of
   * the given name, then an error is thrown.
   *
   * Note that `null` is a valid end cursor and is distinct from
   * `undefined`.
   */
  _getEndCursor(
    objectId: Schema.ObjectId,
    fieldname: Schema.Fieldname
  ): EndCursor | void {
    const result: {|
      +initialized: 0 | 1,
      +endCursor: string | null,
    |} | void = this._db
      .prepare(
        dedent`\
          SELECT
              last_update IS NOT NULL AS initialized,
              end_cursor AS endCursor
          FROM connections
          WHERE object_id = :objectId AND fieldname = :fieldname
        `
      )
      // No need to worry about corruption in the form of multiple
      // matches: there is a UNIQUE(object_id, fieldname) constraint.
      .get({objectId, fieldname});
    if (result === undefined) {
      const s = JSON.stringify;
      throw new Error(`No such connection: ${s(objectId)}.${s(fieldname)}`);
    }
    return result.initialized ? result.endCursor : undefined;
  }

  /**
   * Create a GraphQL selection set to fetch elements from a collection,
   * specified by its enclosing object type and the connection field
   * name (for instance, "Repository" and "issues").
   *
   * If the connection has been queried before and you wish to fetch new
   * elements, use an appropriate end cursor. Use `undefined` otherwise.
   * Note that `null` is a valid end cursor and is distinct from
   * `undefined`. Note that these semantics are compatible with the
   * return value of `_getEndCursor`.
   *
   * If an end cursor for a particular node's connection was specified,
   * then the resulting GraphQL should be embedded in the context of
   * that node. For instance, if repository "foo/bar" has ID "baz" and
   * an end cursor of "c000" on its "issues" connection, then the
   * GraphQL emitted by `_queryConnection("issues", "c000")` might
   * replace the `?` in the following query:
   *
   *     node(id: "baz") { ? }
   *
   * If no end cursor was specified, then the resulting GraphQL may be
   * embedded in the context of _any_ node with a connection of the
   * appropriate fieldname. For instance, `_queryConnection("issues")`
   * emits GraphQL that may replace the `?` in either of the following
   * queries:
   *
   *     node(id: "baz") { ? }  # where "baz" is a repository ID
   *     repository(owner: "foo", name: "bar") { ? }
   *
   * Note, however, that this query will fetch nodes from the _start_ of
   * the connection. It would be wrong to append these results onto an
   * connection for which we have already fetched data.
   *
   * The result of this query has type `ConnectionFieldResult`.
   *
   * This function is pure: it does not interact with the database.
   *
   * See: `_getEndCursor`.
   * See: `_updateConnection`.
   */
  _queryConnection(
    typename: Schema.Typename,
    fieldname: Schema.Fieldname,
    endCursor: EndCursor | void,
    connectionPageSize: number
  ): Queries.Selection[] {
    if (this._schema[typename] == null) {
      throw new Error("No such type: " + JSON.stringify(typename));
    }
    if (this._schema[typename].type !== "OBJECT") {
      const s = JSON.stringify;
      throw new Error(
        `Cannot query connection on non-object type ${s(typename)} ` +
          `(${this._schema[typename].type})`
      );
    }
    const field = this._schemaInfo.objectTypes[typename].fields[fieldname];
    if (field == null) {
      const s = JSON.stringify;
      throw new Error(
        `Object type ${s(typename)} has no field ${s(fieldname)}`
      );
    }
    if (field.type !== "CONNECTION") {
      const s = JSON.stringify;
      throw new Error(
        `Cannot query non-connection field ${s(typename)}.${s(fieldname)} ` +
          `(${field.type})`
      );
    }
    const b = Queries.build;
    const connectionArguments: Queries.Arguments = {
      first: b.literal(connectionPageSize),
    };
    if (endCursor !== undefined) {
      connectionArguments.after = b.literal(endCursor);
    }
    return [
      b.field(fieldname, connectionArguments, [
        b.field("totalCount"),
        b.field("pageInfo", {}, [b.field("endCursor"), b.field("hasNextPage")]),
        b.field("nodes", {}, this._queryShallow(field.elementType)),
      ]),
    ];
  }

  /**
   * Ingest new entries in a connection on an existing object.
   *
   * The connection's last update will be set to the given value, which
   * must be an existing update lest an error be thrown.
   *
   * If the object does not exist or does not have a connection by the
   * given name, an error will be thrown.
   *
   * See: `_queryConnection`.
   * See: `_createUpdate`.
   */
  _updateConnection(
    updateId: UpdateId,
    objectId: Schema.ObjectId,
    fieldname: Schema.Fieldname,
    queryResult: ConnectionFieldResult
  ): void {
    _inTransaction(this._db, () => {
      this._nontransactionallyUpdateConnection(
        updateId,
        objectId,
        fieldname,
        queryResult
      );
    });
  }

  /**
   * As `_updateConnection`, but do not enter any transactions. Other
   * methods may call this method as a subroutine in a larger
   * transaction.
   */
  _nontransactionallyUpdateConnection(
    updateId: UpdateId,
    objectId: Schema.ObjectId,
    fieldname: Schema.Fieldname,
    queryResult: ConnectionFieldResult
  ): void {
    const db = this._db;
    const connectionId: number = this._db
      .prepare(
        dedent`\
          SELECT rowid FROM connections
          WHERE object_id = :objectId AND fieldname = :fieldname
        `
      )
      .pluck()
      .get({objectId, fieldname});
    // There is a UNIQUE(object_id, fieldname) constraint, so we don't
    // have to worry about pollution due to duplicates. But it's
    // possible that no such connection exists, indicating that the
    // object has not been registered. This is an error.
    if (connectionId === undefined) {
      const s = JSON.stringify;
      throw new Error(`No such connection: ${s(objectId)}.${s(fieldname)}`);
    }
    db.prepare(
      dedent`\
          UPDATE connections
          SET
              last_update = :updateId,
              total_count = :totalCount,
              has_next_page = :hasNextPage,
              end_cursor = :endCursor
          WHERE rowid = :connectionId
        `
    ).run({
      updateId,
      totalCount: queryResult.totalCount,
      hasNextPage: +queryResult.pageInfo.hasNextPage,
      endCursor: queryResult.pageInfo.endCursor,
      connectionId,
    });
    let nextIndex: number = db
      .prepare(
        dedent`\
          SELECT IFNULL(MAX(idx), 0) + 1 FROM connection_entries
          WHERE connection_id = :connectionId
        `
      )
      .pluck()
      .get({connectionId});
    const addEntry = db.prepare(
      dedent`\
        INSERT INTO connection_entries (connection_id, idx, child_id)
        VALUES (:connectionId, :idx, :childId)
      `
    );
    for (const node of queryResult.nodes) {
      const childId = this._nontransactionallyRegisterNodeFieldResult(node);
      const idx = nextIndex++;
      addEntry.run({connectionId, idx, childId});
    }
  }
}

/**
 * Decomposition of a schema, grouping types by their kind (object vs.
 * union) and object fields by their kind (primitive vs. link vs.
 * connection).
 *
 * All arrays contain elements in arbitrary order.
 */
type SchemaInfo = {|
  +objectTypes: {|
    +[Schema.Typename]: {|
      +fields: {|+[Schema.Fieldname]: Schema.FieldType|},
      +primitiveFieldNames: $ReadOnlyArray<Schema.Fieldname>,
      +linkFieldNames: $ReadOnlyArray<Schema.Fieldname>,
      +connectionFieldNames: $ReadOnlyArray<Schema.Fieldname>,
      // There is always exactly one ID field, so it needs no
      // special representation. (It's still included in the `fields`
      // dictionary, though.)
    |},
  |},
  +unionTypes: {|
    +[Schema.Fieldname]: {|
      +clauses: $ReadOnlyArray<Schema.Typename>,
    |},
  |},
|};

export function _buildSchemaInfo(schema: Schema.Schema): SchemaInfo {
  const result = {
    objectTypes: (({}: any): {|
      [Schema.Typename]: {|
        +fields: {|+[Schema.Fieldname]: Schema.FieldType|},
        +primitiveFieldNames: Array<Schema.Fieldname>,
        +linkFieldNames: Array<Schema.Fieldname>,
        +connectionFieldNames: Array<Schema.Fieldname>,
      |},
    |}),
    unionTypes: (({}: any): {|
      [Schema.Fieldname]: {|
        +clauses: $ReadOnlyArray<Schema.Typename>,
      |},
    |}),
  };
  for (const typename of Object.keys(schema)) {
    const type = schema[typename];
    switch (type.type) {
      case "OBJECT": {
        const entry: {|
          +fields: {|+[Schema.Fieldname]: Schema.FieldType|},
          +primitiveFieldNames: Array<Schema.Fieldname>,
          +linkFieldNames: Array<Schema.Fieldname>,
          +connectionFieldNames: Array<Schema.Fieldname>,
        |} = {
          fields: type.fields,
          primitiveFieldNames: [],
          linkFieldNames: [],
          connectionFieldNames: [],
        };
        result.objectTypes[typename] = entry;
        for (const fieldname of Object.keys(type.fields)) {
          const field = type.fields[fieldname];
          switch (field.type) {
            case "ID":
              break;
            case "PRIMITIVE":
              entry.primitiveFieldNames.push(fieldname);
              break;
            case "NODE":
              entry.linkFieldNames.push(fieldname);
              break;
            case "CONNECTION":
              entry.connectionFieldNames.push(fieldname);
              break;
            // istanbul ignore next
            default:
              throw new Error((field.type: empty));
          }
        }
        break;
      }
      case "UNION": {
        const entry = {clauses: Object.keys(type.clauses)};
        result.unionTypes[typename] = entry;
        break;
      }
      // istanbul ignore next
      default:
        throw new Error((type.type: empty));
    }
  }
  return result;
}

type UpdateId = number;

/**
 * A set of objects and connections that should be updated.
 */
type QueryPlan = {|
  +objects: $ReadOnlyArray<{|
    +typename: Schema.Typename,
    +id: Schema.ObjectId,
  |}>,
  +connections: $ReadOnlyArray<{|
    +objectId: Schema.ObjectId,
    +fieldname: Schema.Fieldname,
    +endCursor: EndCursor | void, // `undefined` if never fetched
  |}>,
|};

/**
 * An `endCursor` of a GraphQL `pageInfo` object, denoting where the
 * cursor should continue reading the next page. This is `null` when the
 * cursor is at the beginning of the connection (i.e., when the
 * connection is empty, or when `first: 0` is provided).
 */
type EndCursor = string | null;

type NodeFieldResult = {|
  +__typename: Schema.Typename,
  +id: Schema.ObjectId,
|} | null;
type ConnectionFieldResult = {|
  +totalCount: number,
  +pageInfo: {|+hasNextPage: boolean, +endCursor: string | null|},
  +nodes: $ReadOnlyArray<NodeFieldResult>,
|};

/**
 * Execute a function inside a database transaction.
 *
 * The database must not be in a transaction. A new transaction will be
 * entered, and then the callback will be invoked.
 *
 * If the callback completes normally, then its return value is passed
 * up to the caller, and the currently active transaction (if any) is
 * committed.
 *
 * If the callback throws an error, then the error is propagated to the
 * caller, and the currently active transaction (if any) is rolled back.
 *
 * Note that the callback may choose to commit or roll back the
 * transaction before returning or throwing an error. Conversely, note
 * that if the callback commits the transaction, and then begins a new
 * transaction but does not end it, then this function will commit the
 * new transaction if the callback returns (or roll it back if it
 * throws).
 */
export function _inTransaction<R>(db: Database, fn: () => R): R {
  if (db.inTransaction) {
    throw new Error("already in transaction");
  }
  try {
    db.prepare("BEGIN").run();
    const result = fn();
    if (db.inTransaction) {
      db.prepare("COMMIT").run();
    }
    return result;
  } finally {
    if (db.inTransaction) {
      db.prepare("ROLLBACK").run();
    }
  }
}

/*
 * In some cases, we need to interpolate user input in SQL queries in
 * positions that do not allow bound variables in prepared statements
 * (e.g., table and column names). In these cases, we manually sanitize.
 *
 * If this function returns `true`, then its argument may be safely
 * included in a SQL identifier. If it returns `false`, then no such
 * guarantee is made (this function is overly conservative, so it is
 * possible that the argument may in fact be safe).
 *
 * For instance, the function will return `true` if passed "col", but
 * will return `false` if passed "'); DROP TABLE objects; --".
 */
function isSqlSafe(token: string) {
  return !token.match(/[^A-Za-z0-9_]/);
}

/**
 * Get the name of the table used to store primitive data for objects of
 * the given type, which should be SQL-safe lest an error be thrown.
 *
 * Note that the resulting string is double-quoted.
 */
function _primitivesTableName(typename: Schema.Typename) {
  // istanbul ignore if
  if (!isSqlSafe(typename)) {
    // This shouldn't be reachable---we should have caught it earlier.
    // But checking it anyway is cheap.
    throw new Error(
      "Invariant violation: invalid object type name " +
        JSON.stringify(typename)
    );
  }
  return `"primitives_${typename}"`;
}

/**
 * Convert a prepared statement into a JS function that executes that
 * statement and asserts that it makes exactly one change to the
 * database.
 *
 * The prepared statement must use only named parameters, not positional
 * parameters.
 *
 * The prepared statement must not return data (e.g., INSERT and UPDATE
 * are okay; SELECT is not).
 *
 * The statement is not executed inside an additional transaction, so in
 * the case that the assertion fails, the effects of the statement are
 * not rolled back by this function.
 *
 * This is useful when the statement is like `UPDATE ... WHERE id = ?`
 * and it is assumed that `id` is a primary key for a record already
 * exists---if either existence or uniqueness fails, this method will
 * raise an error quickly instead of leading to a corrupt state.
 *
 * For example, this code...
 *
 *     const setName: ({|+userId: string, +newName: string|}) => void =
 *       _makeSingleUpdateFunction(
 *         "UPDATE users SET name = :newName WHERE id = :userId"
 *       );
 *     setName({userId: "user:foo", newName: "The Magnificent Foo"});
 *
 * ...will update `user:foo`'s name, or throw an error if there is no
 * such user or if multiple users have this ID.
 */
export function _makeSingleUpdateFunction<Args: BindingDictionary>(
  stmt: Statement
): (Args) => void {
  if (stmt.returnsData) {
    throw new Error(
      "Cannot create update function for statement that returns data: " +
        stmt.source
    );
  }
  return (args: Args) => {
    const result = stmt.run(args);
    if (result.changes !== 1) {
      throw new Error(
        "Bad change count: " +
          JSON.stringify({source: stmt.source, args, changes: result.changes})
      );
    }
  };
}