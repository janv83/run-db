/**
 * index.js
 *
 * Indexer API
 */

const Database = require('./database')
const Downloader = require('./downloader')
const Executor = require('./executor')
const Graph = require('./graph')
const Crawler = require('./crawler')
const { DEFAULT_TRUSTLIST } = require('./config')

// ------------------------------------------------------------------------------------------------
// Indexer
// ------------------------------------------------------------------------------------------------

class Indexer {
  constructor (db, api, network, numParallelDownloads, numParallelExecutes, logger, startHeight) {
    this.logger = logger || {}
    this.logger.info = this.logger.info || (() => {})
    this.logger.warn = this.logger.warn || (() => {})
    this.logger.error = this.logger.error || (() => {})
    this.logger.debug = this.logger.debug || (() => {})

    this.onIndex = null
    this.onFailToIndex = null

    this.api = api
    this.network = network
    this.startHeight = startHeight

    this.database = new Database(db)
    this.downloader = new Downloader(this.api.fetch.bind(this.api), network, numParallelDownloads)
    this.trustlist = new Set(DEFAULT_TRUSTLIST)
    this.graph = new Graph(this.trustlist)
    this.executor = new Executor(network, numParallelExecutes)
    this.crawler = new Crawler(api)

    this.downloader.onDownloadTransaction = this._onDownloadTransaction.bind(this)
    this.downloader.onFailedToDownloadTransaction = this._onFailedToDownloadTransaction.bind(this)
    this.downloader.onRetryingDownload = this._onRetryingDownload.bind(this)
    this.graph.onReadyToExecute = this._onReadyToExecute.bind(this)
    this.graph.onFailToParse = this._onFailToParse.bind(this)
    this.executor.onCacheGet = this._onCacheGet.bind(this)
    this.executor.onBlockchainFetch = this._onBlockchainFetch.bind(this)
    this.executor.onTrustlistGet = this._onTrustlistGet.bind(this)
    this.executor.onExecuted = this._onExecuted.bind(this)
    this.executor.onExecuteFailed = this._onExecuteFailed.bind(this)
    this.executor.onMissingDeps = this._onMissingDeps.bind(this)
    this.crawler.onCrawlError = this._onCrawlError.bind(this)
    this.crawler.onCrawlBlockTransactions = this._onCrawlBlockTransactions.bind(this)
    this.crawler.onRewindBlocks = this._onRewindBlocks.bind(this)
  }

  async start () {
    this.database.open()
    this.database.getTrustlist().forEach(txid => {
      this.trustlist.add(txid)
    })
    this.database.forEachTransaction((txid, hex, executable, executed) => {
      this.graph.add(txid, hex, executable, executed)
      if (!hex) this.downloader.add(txid)
    })
    this.executor.start()
    const height = this.database.getHeight() || this.startHeight
    const hash = this.database.getHash()
    if (this.api.connect) await this.api.connect(height, this.network)
    this.crawler.start(height, hash)
  }

  async stop () {
    this.crawler.stop()
    if (this.api.disconnect) await this.api.disconnect()
    this.downloader.stop()
    this.database.close()
    await this.executor.stop()
  }

  add (txid, hex = null, height = null) {
    if (!/[0-9a-f]{64}/.test(txid)) throw new Error('Not a txid: ' + txid)
    this.logger.info('Adding', txid)

    this.database.transaction(() => {
      this.database.addNewTransaction(txid, height)
      if (hex) this.database.setTransactionHex(txid, hex)
      if (height) this.database.setTransactionHeight(txid, height)
      this.database.setTransactionExecutable(txid, true)
    })

    if (this.graph.has(txid)) {
      this.graph.setExecutable(txid)
    } else {
      this.graph.add(txid, hex, true, false)
    }

    if (hex) {
      this.graph.setDownloaded(txid, hex)
    } else {
      this.downloader.add(txid)
    }
  }

  remove (txid) {
    if (!/[0-9a-f]{64}/.test(txid)) throw new Error('Not a txid: ' + txid)
    this.logger.info('Removing', txid)
    this.downloader.remove(txid)
    this.graph.remove(txid)
    this.database.deleteTransaction(txid)
    this.database.deleteJigStates(txid)
    this.database.deleteBerryStates(txid)
  }

  jig (location) {
    return this.database.getJigState(location)
  }

  berry (location) {
    return this.database.getBerryState(location)
  }

  tx (txid) {
    return this.database.getTransactionHex(txid)
  }

  trust (txid) {
    txid = txid.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('Not a txid: ' + txid)
    this.logger.info('Trusting', txid)
    this.database.addToTrustlist(txid)
    this.trustlist.add(txid)
    this.graph.onTrust(txid)
  }

  untrust (txid) {
    this.logger.info('Untrusting', txid)
    this.trustlist.delete(txid)
    this.graph.onUntrust(txid)
    this.database.removeFromTrustlist(txid)
  }

  untrusted () {
    return Array.from(this.graph.untrusted)
  }

  _onDownloadTransaction (txid, hex) {
    this.logger.info(`Downloaded ${txid} (${this.downloader.remaining()} remaining)`)
    this.database.setTransactionHex(txid, hex)
    this.graph.setDownloaded(txid, hex)
  }

  _onFailedToDownloadTransaction (txid, e) {
    this.logger.error('Failed to download', txid, e.toString())
  }

  _onRetryingDownload (txid, secondsToRetry) {
    this.logger.info('Retrying download', txid, 'after', secondsToRetry, 'seconds')
  }

  _onReadyToExecute (txid) {
    const hex = this.database.getTransactionHex(txid)
    this.executor.execute(txid, hex)
  }

  _onFailToParse (txid) {
    this.logger.error('Failed to parse', txid)
    this.database.setTransactionExecuted(txid, true)
  }

  _onCacheGet (key) {
    if (key.startsWith('jig://')) {
      const state = this.database.getJigState(key.slice('jig://'.length))
      if (state) return JSON.parse(state)
    }
    if (key.startsWith('berry://')) {
      const state = this.database.getBerryState(key.slice('berry://'.length))
      if (state) return JSON.parse(state)
    }
    if (key.startsWith('tx://')) {
      return this.database.getTransactionHex(key.slice('tx://'.length))
    }
  }

  _onBlockchainFetch (txid) {
    const rawtx = this.database.getTransactionHex(txid)
    if (!rawtx) throw new Error(`Not found: ${txid}`)
    return rawtx
  }

  _onTrustlistGet () {
    return this.trustlist
  }

  _onExecuted (txid, state) {
    this.logger.info(`Executed ${txid} (${this.graph.remaining.size - 1} remaining)`)

    this.database.transaction(() => {
      this.database.setTransactionExecuted(txid, true)

      for (const key of Object.keys(state)) {
        if (key.startsWith('jig://')) {
          const location = key.slice('jig://'.length)
          this.database.setJigState(location, JSON.stringify(state[key]))
          continue
        }

        if (key.startsWith('berry://')) {
          const location = key.slice('berry://'.length)
          this.database.setBerryState(location, JSON.stringify(state[key]))
          continue
        }
      }
    })

    this.graph.setExecuted(txid)

    if (this.onIndex) this.onIndex(txid)
  }

  _onExecuteFailed (txid, e) {
    this.logger.error(`Failed to execute ${txid}: ${e.toString()}`)

    this.database.setTransactionExecuted(txid, true)

    this.graph.setExecuted(txid)

    if (this.onFailToIndex) this.onFailToIndex(txid, e)
  }

  _onMissingDeps (txid, deptxids) {
    this.logger.debug(`Discovered ${deptxids.size} dep(s) for ${txid}`)

    for (const deptxid of deptxids) {
      this.database.addNewTransaction(deptxid, null)
      this.graph.addDep(txid, deptxid)

      const hex = this.database.getTransactionHex(deptxid)

      if (hex) {
        this.graph.setDownloaded(hex)
      } else {
        this.downloader.add(deptxid)
      }
    }
  }

  _onCrawlError (e) {
    this.logger.error(`Crawl error: ${e.toString()}`)
  }

  _onCrawlBlockTransactions (height, hash, txids, txhexs) {
    this.logger.info(`Crawled block ${height} for ${txids.length} transactions`)

    this.database.transaction(() => {
      for (let i = 0; i < txids.length; i++) {
        const txid = txids[i]
        const hex = txhexs && txhexs[i]

        this.logger.info('Adding', txid)

        this.database.addNewTransaction(txid, height)
        if (hex) this.database.setTransactionHex(txid, hex)
        this.database.setTransactionExecutable(txid, true)
      }

      this.database.setHeightAndHash(height, hash)
    })

    for (let i = 0; i < txids.length; i++) {
      const txid = txids[i]
      const hex = txhexs && txhexs[i]

      if (this.graph.has(txid)) {
        this.graph.setExecutable(txid)
      } else {
        this.graph.add(txid, hex, true, false)
      }

      if (hex) {
        this.graph.setDownloaded(txid, hex)
      } else {
        this.downloader.add(txid)
      }
    }
  }

  _onRewindBlocks (newHeight) {
    this.logger.info(`Rewinding to block ${newHeight}`)

    const txids = this.database.getTransactionsAboveHeight(newHeight)

    txids.forEach(txid => {
      this.logger.info('Removing', txid)
      this.downloader.remove(txid)
      this.graph.remove(txid)
    })

    this.database.transaction(() => {
      txids.forEach(txid => {
        this.database.deleteTransaction(txid)
        this.database.deleteJigStates(txid)
        this.database.deleteBerryStates(txid)
      })
    })
  }
}

// ------------------------------------------------------------------------------------------------

module.exports = Indexer