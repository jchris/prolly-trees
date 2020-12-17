/* globals describe, it */
import { sql, Database } from './index.js'
import { nocache } from '../src/cache.js'
import { deepStrictEqual as same } from 'assert'
import { bf } from '../src/utils.js'
import { SparseArrayLeaf } from '../src/sparse-array.js'
import { DBIndexLeaf, DBIndexBranch } from '../src/db-index.js'

const chunker = bf(3)

const cache = nocache

const { keys, entries } = Object

const storage = () => {
  const blocks = {}
  const put = block => {
    blocks[block.cid.toString()] = block
  }
  const get = async cid => {
    const block = blocks[cid.toString()]
    if (!block) throw new Error('Not found')
    return block
  }
  return { get, put, blocks }
}

const createPersons = `CREATE TABLE Persons (
  PersonID int,
  LastName varchar(255),
  FirstName varchar(255),
  Address varchar(255),
  City varchar(255)
)`

const createPersons2 = `CREATE TABLE Persons2 (
  PersonID int,
  LastName varchar(255),
  FirstName varchar(255),
  Address varchar(255),
  City varchar(255)
)`

const insertOnlyId = 'INSERT INTO Persons (PersonID) VALUES (4006)'
const insertFullRow = 'INSERT INTO Persons VALUES (12, \'Rogers\', \'Mikeal\', \'241 BVA\', \'San Francisco\')'
const insertTwoRows = insertFullRow + ', (13, \'Rogers\', \'NotMikeal\', \'241 AVB\', \'San Francisco\')'

const runSQL = async (q, database = Database.create(), store = storage()) => {
  const iter = database.sql(q, { chunker })

  let last
  for await (const block of iter) {
    await store.put(block)
    last = block
  }
  const opts = { get: store.get, cache, chunker }
  const db = await Database.from(last.cid, opts)
  return { database: db, store, cache, root: last.cid }
}

const verifyPersonTable = table => {
  const expected = [
    {
      name: 'PersonID',
      dataType: 'INT'
    },
    {
      name: 'LastName',
      dataType: 'VARCHAR',
      length: 255
    },
    {
      name: 'FirstName',
      dataType: 'VARCHAR',
      length: 255
    },
    {
      name: 'Address',
      dataType: 'VARCHAR',
      length: 255
    },
    {
      name: 'City',
      dataType: 'VARCHAR',
      length: 255
    }
  ]
  for (const column of table.columns) {
    const { name, dataType, length } = expected.shift()
    same(column.name, name)
    same(column.schema.definition.dataType, dataType)
    same(column.schema.definition.length, length)
  }
}

describe('sql', () => {
  it('basic create', async () => {
    const { database: db } = await runSQL(createPersons)
    same(entries(db.tables).length, 1)
    same(db.tables.Persons.rows, null)
    verifyPersonTable(db.tables.Persons)
  })

  it('create twice', async () => {
    const { database, store } = await runSQL(createPersons)
    const db = (await runSQL(createPersons2, database, store)).database
    same(entries(db.tables).length, 2)
    same(db.tables.Persons2.rows, null)
    verifyPersonTable(db.tables.Persons)
    verifyPersonTable(db.tables.Persons2)
  })

  it('insert initial row', async () => {
    const { database, store } = await runSQL(createPersons)
    const { database: db } = await runSQL(insertFullRow, database, store)
    const table = db.tables.Persons
    same(table.rows instanceof SparseArrayLeaf, true)
    for (const column of table.columns) {
      same(column.index instanceof DBIndexLeaf, true)
    }
  })

  const onlyFirstRow = [[12, 'Rogers', 'Mikeal', '241 BVA', 'San Francisco']]
  const onlySecondRow = [[13, 'Rogers', 'NotMikeal', '241 AVB', 'San Francisco']]

  it('select all columns', async () => {
    const { database, store } = await runSQL(createPersons)
    const { database: db } = await runSQL(insertFullRow, database, store)
    const result = db.sql('SELECT * FROM Persons')
    const all = await result.all()
    same(all, onlyFirstRow)
  })

  const twoRowExpected = [
    onlyFirstRow[0],
    onlySecondRow[0]
  ]

  it('insert two rows and select', async () => {
    const { database, store } = await runSQL(createPersons)
    const { database: db } = await runSQL(insertTwoRows, database, store)
    const table = db.tables.Persons
    same(table.rows instanceof SparseArrayLeaf, true)
    for (const column of table.columns) {
      same(column.index instanceof DBIndexLeaf || column.index instanceof DBIndexBranch, true)
    }
    const result = db.sql('SELECT * FROM Persons')
    const all = await result.all()
    same(all, twoRowExpected)
  })

  it('select two columns', async () => {
    const { database, store } = await runSQL(createPersons)
    const { database: db } = await runSQL(insertFullRow, database, store)
    const result = db.sql('SELECT FirstName, LastName FROM Persons')
    const all = await result.all()
    same(all, [['Mikeal', 'Rogers']])
  })

  it('select * where (string comparison)', async () => {
    const { database, store } = await runSQL(createPersons)
    const { database: db } = await runSQL(insertTwoRows, database, store)
    let result = db.sql('SELECT * FROM Persons WHERE FirstName="Mikeal"')
    let all = await result.all()
    same(all, onlyFirstRow)
    result = db.sql('SELECT * FROM Persons WHERE FirstName="NotMikeal"')
    all = await result.all()
    same(all, onlySecondRow)
  })

  it('select * where (string comparison AND)', async () => {
    const { database, store } = await runSQL(createPersons)
    const { database: db } = await runSQL(insertTwoRows, database, store)
    let result = db.sql('SELECT * FROM Persons WHERE FirstName="Mikeal" AND LastName="Rogers"')
    let all = await result.all()
    same(all, onlyFirstRow)
    result = db.sql('SELECT * FROM Persons WHERE FirstName="NotMikeal" AND LastName="Rogers"')
    all = await result.all()
    same(all, onlySecondRow)
    result = db.sql('SELECT * FROM Persons WHERE FirstName="Mikeal" AND LastName="NotRogers"')
    all = await result.all()
    same(all, [])
    result = db.sql('SELECT * FROM Persons WHERE FirstName="NotMikeal" AND LastName="NotRogers"')
    all = await result.all()
    same(all, [])
  })

  it('select * where (string comparison OR)', async () => {
    const { database, store } = await runSQL(createPersons)
    const { database: db } = await runSQL(insertTwoRows, database, store)
    let result = db.sql('SELECT * FROM Persons WHERE FirstName="Mikeal" OR LastName="NotRogers"')
    let all = await result.all()
    same(all, onlyFirstRow)
    result = db.sql('SELECT * FROM Persons WHERE FirstName="NotMikeal" OR LastName="NotRogers"')
    all = await result.all()
    same(all, onlySecondRow)
    result = db.sql('SELECT * FROM Persons WHERE FirstName="XMikeal" OR LastName="XRogers"')
    all = await result.all()
    same(all, [])
  })

  it('select * where (string comparison AND 3x)', async () => {
    const { database, store } = await runSQL(createPersons)
    const { database: db } = await runSQL(insertTwoRows, database, store)
    const pre = 'SELECT * FROM Persons WHERE '
    let result = db.sql(pre + 'FirstName="Mikeal" AND LastName="Rogers" AND City="San Francisco"')
    let all = await result.all()
    same(all, onlyFirstRow)
    result = db.sql(pre + 'FirstName="NotMikeal" AND LastName="Rogers" AND City="San Francisco"')
    all = await result.all()
    same(all, onlySecondRow)
    result = db.sql(pre + 'FirstName="XMikeal" OR LastName="XRogers"')
    all = await result.all()
    same(all, [])
  })

  it('select * where (string comparison OR 3x)', async () => {
    const { database, store } = await runSQL(createPersons)
    const { database: db } = await runSQL(insertTwoRows, database, store)
    const pre = 'SELECT * FROM Persons WHERE '
    let result = db.sql(pre + 'FirstName="X" OR LastName="X" OR City="San Francisco"')
    let all = await result.all()
    same(all, twoRowExpected)
    result = db.sql(pre + 'FirstName="X" OR LastName="X" OR City="San Francisco"')
    all = await result.all()
    same(all, twoRowExpected)
    result = db.sql(pre + 'FirstName="XMikeal" OR LastName="XRogers" OR City="X"')
    all = await result.all()
    same(all, [])
  })

  it('select * where (int ranges)', async () => {
    const create = 'CREATE TABLE Test ( ID int )'
    const { database, store } = await runSQL(create)
    const values = [...Array(10).keys()].map(k => `(${k})`).join(', ')
    const inserts = `INSERT INTO Test VALUES ${values}`
    const { database: db } = await runSQL(inserts, database, store)
    const pre = 'SELECT * FROM Test WHERE '
    let result = db.sql(pre + 'ID > 1 AND ID < 3')
    let all = await result.all()
    same(all, [[2]])
    result = db.sql(pre + 'ID >= 2 AND ID <= 3')
    all = await result.all()
    same(all, [[2], [3]])
  })

  it('select * where (string ranges)', async () => {
    const create = 'CREATE TABLE Test ( Name varchar(255) )'
    const { database, store } = await runSQL(create)
    const values = ['a', 'b', 'c', 'd', 'e', 'f'].map(k => `("${k}")`).join(', ')
    const inserts = `INSERT INTO Test VALUES ${values}`
    const { database: db } = await runSQL(inserts, database, store)
    const pre = 'SELECT * FROM Test WHERE '
    let result = db.sql(pre + 'Name > "a" AND Name < "c"')
    let all = await result.all()
    same(all, [['b']])
    result = db.sql(pre + 'Name >= "b" AND Name <= "d"')
    all = await result.all()
    same(all, [['b'], ['c'], ['d']])
  })

  it('select * where (int range operators)', async () => {
    const create = 'CREATE TABLE Test ( ID int )'
    const { database, store } = await runSQL(create)
    const values = [...Array(10).keys()].map(k => `(${k})`).join(', ')
    const inserts = `INSERT INTO Test VALUES ${values}`
    const { database: db } = await runSQL(inserts, database, store)
    const pre = 'SELECT * FROM Test WHERE '
    let result = db.sql(pre + 'ID < 3')
    let all = await result.all()
    same(all, [[0], [1], [2]])
    result = db.sql(pre + 'ID > 8')
    all = await result.all()
    same(all, [[9]])
    result = db.sql(pre + 'ID <= 2')
    all = await result.all()
    same(all, [[0], [1], [2]])
    result = db.sql(pre + 'ID >= 9')
    all = await result.all()
    same(all, [[9]])
  })

  it('select * where (string range operators)', async () => {
    const create = 'CREATE TABLE Test ( Name varchar(255) )'
    const { database, store } = await runSQL(create)
    const values = ['a', 'b', 'c', 'd', 'e', 'f'].map(k => `("${k}")`).join(', ')
    const inserts = `INSERT INTO Test VALUES ${values}`
    const { database: db } = await runSQL(inserts, database, store)
    const pre = 'SELECT * FROM Test WHERE '
    let result = db.sql(pre + 'Name > "e"')
    let all = await result.all()
    same(all, [['f']])
    result = db.sql(pre + 'Name >= "e"')
    all = await result.all()
    same(all, [['e'], ['f']])
    result = db.sql(pre + 'Name < "b"')
    all = await result.all()
    same(all, [['a']])
    result = db.sql(pre + 'Name <= "b"')
    all = await result.all()
    same(all, [['a'], ['b']])
  })

  it('select * where (ORDER BY int)', async () => {
    const create = 'CREATE TABLE Test ( Name varchar(255), Id int )'
    const { database, store } = await runSQL(create)
    let i = 0
    const values = ['a', 'b', 'c', 'd', 'e', 'f'].reverse().map(k => `("${k}", ${i++})`).join(', ')
    const inserts = `INSERT INTO Test VALUES ${values}`
    const { database: db } = await runSQL(inserts, database, store)
    const pre = 'SELECT * FROM Test WHERE '
    const query = pre + 'Name > "a" AND Name < "f" ORDER BY Id'
    let result = db.sql(query)
    let all = await result.all()
    const expected = [['e', 1], ['d', 2], ['c', 3], ['b', 4]]
    same(all, expected)
    result = db.sql(query + ' DESC')
    all = await result.all()
    same(all, expected.reverse())
  })

  it('select * where (ORDER BY string)', async () => {
    const create = 'CREATE TABLE Test ( Name varchar(255), Id int )'
    const { database, store } = await runSQL(create)
    let i = 0
    const values = ['a', 'b', 'c', 'd', 'e', 'f'].reverse().map(k => `("${k}", ${i++})`).join(', ')
    const inserts = `INSERT INTO Test VALUES ${values}`
    const { database: db } = await runSQL(inserts, database, store)
    const pre = 'SELECT * FROM Test WHERE '
    const query = pre + 'Id > 1 AND Id < 5 ORDER BY Name'
    let result = db.sql(query)
    let all = await result.all()
    const expected = [['b', 4], ['c', 3], ['d', 2]]
    same(all, expected)
    result = db.sql(query + ' DESC')
    all = await result.all()
    same(all, expected.reverse())
  })
})
