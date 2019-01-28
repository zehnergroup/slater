const fs = require('fs-extra')
const path = require('path')
const onExit = require('exit-hook')
const exit = require('exit')
const chokidar = require('chokidar')

/**
 * internal modules
 */
const spaghetti = require('@friendsof/spaghetti')
const sync = require('@slater/sync')
const {
  logger,
  match,
  sanitize
} = require('@slater/util')

/**
 * library specific deps
 */
const { socket, closeServer } = require('./socket.js')

const log = logger('@slater/cli')

/**
 * kinda gross, but looks nice in the console
 */
function logAssets ({ duration, assets }, persist) {
  log.info('built', ` in ${duration}ms\n${assets.reduce((_, asset, i) => {
    const size = asset.size.gzip ? asset.size.gzip + 'kb gzipped' : asset.size.raw + 'kb'
    return _ += `  > ${log.colors.gray(asset.filename)} ${size}${i !== assets.length - 1 ? `\n` : ''}`
  }, '')}`, persist)
}

/**
 * input absolute filepath, return
 *   - its filename (as a Shopify "key")
 *   - where it's coming from
 *   - where it's going
 *
 *   e.g. "/Users/user/Sites/projects/my-project/src/snippets/snip.liquid"
 *
 *   {
 *     filename: "snippets/snip.liquid",
 *     src: "/Users/user/Sites/projects/my-project/src/snippets/snip.liquid",
 *     dest: "/Users/user/Sites/projects/my-project/build/snippets/snip.liquid"
*    }
 */
function formatFile (filepath, src, dest) {
  if (!filepath) return {}

  const filename = sanitize(filepath)

  return {
    filename,
    src: filepath,
    dest: path.join(dest, filename)
  }
}

module.exports = function createApp (config, shopifyconfig) {
  /**
   * theme here is optional, and is only needed
   * for the watch task
   */
  const theme = shopifyconfig ? sync(shopifyconfig) : {}

  return {
    copy () {
      return new Promise((res, rej) => {
        fs.emptyDir(config.out)
          .then(() => {
            fs.copy(config.in, config.out, {
              filter (src, dest) {
                return !match(src, shopifyconfig.ignore_files)
              }
            })
              .then(res)
              .catch(e => {
                log.error(e.message || e)
                rej(e)
                exit()
              })
          })
          .catch(e => {
            log.error(e.message || e)
            rej(e)
            exit()
          })
      })
    },
    build () {
      log.info('building', '', true)

      return new Promise((res, rej) => {
        spaghetti(config.js)
          .build()
          .end(stats => {
            logAssets(stats, true)
            res()
          })
          .error(e => {
            log.error(e.message || e || '')
            rej(e)
          })
      })
    },
    watch () {
      log.info('watching')

      /**
       * utilities for watch task only
       */
      function copyFile ({ filename, src, dest }) {
        return fs.copy(src, dest)
          .catch(e => {
            log.error(`copying ${filename} failed\n${e.message || e}`)
          })
      }
      function deleteFile ({ filename, src, dest }) {
        return fs.remove(dest)
          .catch(e => {
            log.error(`deleting ${filename} failed\n${e.message || e}`)
          })
      }
      function syncFile ({ filename, src, dest }) {
        if (!filename) return Promise.resolve(true)

        return theme.sync(dest)
          .then(() => socket.emit('refresh'))
          .then(() => {
            log.info('synced', filename)
          })
          .catch(e => {
            log.error(`syncing ${filename} failed\n${e.message || e || ''}`)
          })
      }
      function unsyncFile ({ filename, src, dest }) {
        if (!filename) return Promise.resolve(true)

        return theme.unsync(dest)
          .then(() => socket.emit('refresh'))
          .then(() => {
            log.info('unsynced', filename)
          })
          .catch(e => {
            log.error(`unsyncing ${filename} failed\n${e.message || e || ''}`)
          })
      }

      const watchers = [
        chokidar.watch(config.in, {
          persistent: true,
          ignoreInitial: true,
          ignore: shopifyconfig.ignore_files
        })
          .on('add', file => {
            // @see https://github.com/paulmillr/chokidar/issues/773
            if (match(file, shopifyconfig.ignore_files)) return
            copyFile(formatFile(file, config.in, config.out))
          })
          .on('change', file => {
            if (match(file, shopifyconfig.ignore_files)) return
            copyFile(formatFile(file, config.in, config.out))
          })
          .on('unlink', file => {
            if (match(file, shopifyconfig.ignore_files)) return
            deleteFile(formatFile(file, config.in, config.out))
          }),

        chokidar.watch(config.out, {
          ignore: /DS_Store/,
          persistent: true,
          ignoreInitial: true
        })
          .on('add', file => syncFile(formatFile(file, config.in, config.out)))
          .on('change', file => syncFile(formatFile(file, config.in, config.out)))
          .on('unlink', file => unsyncFile(formatFile(file, config.in, config.out)))
      ]

      spaghetti(config.js)
        .watch()
        .end(stats => {
          logAssets(stats, false)
        })
        .error(e => {
          log.error(e.message || e || '')
        })

      onExit(() => {
        watchers.map(w => w.close())
        closeServer()
      })
    }
  }
}
