/**
 * index.js
 *
 * Entry point
 */

const Indexer = require('./indexer')
const Server = require('./server')
const {
  API, RPC_PORT, RPC_USER, RPC_PASS, DB, PORT, NETWORK,
  FETCH_LIMIT, WORKERS, MATTERCLOUD_KEY, PLANARIA_TOKEN, START_HEIGHT
} = require('./config')
const MatterCloud = require('./mattercloud')
const Planaria = require('./planaria')
const Bitcoind = require('./bitcoind')

// ------------------------------------------------------------------------------------------------
// Globals
// ------------------------------------------------------------------------------------------------

let crawler = null
switch (API) {
  case 'mattercloud': crawler = new MatterCloud(MATTERCLOUD_KEY); break
  case 'planaria': crawler = new Planaria(PLANARIA_TOKEN); break
  case 'bitcoind': crawler = new Bitcoind(RPC_PORT, RPC_USER, RPC_PASS); break
  case 'none': crawler = { connect: null, disconnect: null, fetch: null, getNextBlock: null }; break
  default: throw new Error(`Unknown API: ${API}`)
}

const logger = console
const indexer = new Indexer(DB, crawler, NETWORK, FETCH_LIMIT, WORKERS, logger, START_HEIGHT)
const server = new Server(indexer, logger, PORT)

// ------------------------------------------------------------------------------------------------
// main
// ------------------------------------------------------------------------------------------------

async function main () {
  await indexer.start()
  server.start()
}

// ------------------------------------------------------------------------------------------------
// shutdown
// ------------------------------------------------------------------------------------------------

async function shutdown () {
  await indexer.stop()
  process.exit(0)
}

// ------------------------------------------------------------------------------------------------

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

main()