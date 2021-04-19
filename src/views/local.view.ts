import fs from 'fs'
import path from 'path'
import vscode, { StatusBarItem } from 'vscode'

import { ViewList } from '../views/list.view'
import { BaseTreeProvider, BaseTreeItem, BaseTreeItemOptions } from '../core'
import { config, log, localize, WORKSPACE_PATH, CONFIG_GROUP } from '../tools'

export interface ExtLocalItemOptions {
  /** 文件路径 */
  filePath: string
  /** 接口主键 (对应 pathName) */
  namespace?: string
}

export class ViewLocal extends BaseTreeProvider<LocalItem> {
  public statusBarItem: StatusBarItem = vscode.window.createStatusBarItem()
  public localFilesList: FileHeaderInfo[] = []
  public localFilesMap = new Map<string, FileHeaderInfo>()

  private localPath = path.resolve(WORKSPACE_PATH || '', config.extConfig.savePath)
  public viewList: ViewList

  constructor(viewList: ViewList) {
    super()
    this.viewList = viewList
    this.initLocalFiles()
    this.initStatusBarItem()

    /** 监听文件保存 */
    vscode.workspace.onDidSaveTextDocument(({ languageId, fileName }) => {
      // 过滤非 TS 语言文件
      if (languageId !== 'typescript') return
      // 过滤非接口目录文件
      if (!fileName.includes(this.localPath)) return

      this.updateSingle(fileName)
    })
  }

  /** 初始化本地文件 */
  initLocalFiles() {
    this.localFilesMap.clear()

    if (fs.existsSync(this.localPath)) {
      const localFiles: string[] = []

      fs.readdirSync(this.localPath).forEach((file) => {
        const filePath = path.join(this.localPath, file)
        const fileInfo = this.readLocalFile(filePath)

        if (fileInfo && fileInfo.ext === 'ts') {
          localFiles.push(filePath)
          this.localFilesMap.set(fileInfo.fileName, fileInfo)
        }
      })

      vscode.commands.executeCommand('setContext', `${CONFIG_GROUP}.localFiles`, localFiles)
      this.refactorLocalFilesList()
    } else {
      log.warn('<initLocalFiles> localPath does not exist')
    }
  }

  /** 初始化状态栏按钮 */
  initStatusBarItem() {
    const { showStatusbarItem, swaggerJsonUrl } = config.extConfig
    this.statusBarItem.text = `$(sync) ${localize.getLocalize('text.updateButton')}`
    this.statusBarItem.command = 'cmd.local.updateAll'
    if (showStatusbarItem && swaggerJsonUrl.length) {
      this.statusBarItem.show()
    } else {
      this.statusBarItem.hide()
    }
  }

  /** 读取本地文件 */
  readLocalFile(fileName: string): FileHeaderInfo | undefined {
    try {
      const fileStr = fs.readFileSync(fileName, 'utf-8')
      const headerStr = fileStr.replace(
        /^[\s]*\/\*\*(.*?)\*\/.*declare\s+namespace\s+([^\s\n]+).+$/s,
        '$1* @namespace $2\n'
      )

      const headerInfo: FileHeaderInfo = {
        fileName: fileName.replace(/^.+\/(.+?)(\.d)?\.{.+}$/, '$1'),
        filePath: fileName,
        ext: fileName.replace(/^.+\.(.+)$/, '$1'),
      }

      headerStr.replace(/\*\s*@([^\s]+)[^\S\n]*([^\n]*?)\n/g, (_, key, value) => {
        headerInfo[key] = value || true
        return ''
      })

      return headerInfo
    } catch (error) {
      log.error(`Read File Error - ${fileName}`)
    }
  }

  /** 更新所有本地接口 */
  public updateAll() {
    const statusBarItemText = `$(sync) ${localize.getLocalize('text.updateButton')}`
    this.statusBarItem.text = statusBarItemText + '...'
    this.statusBarItem.command = undefined
    const progressPanel = vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: localize.getLocalize('text.updateButtonTooltips'),
        cancellable: false,
      },
      async (progress) => {
        return new Promise(async (resolve) => {
          progress.report({ increment: -1 })

          await this.viewList._refresh()

          const unit = 100 / this.localFilesMap.size
          let increment = 0
          progress.report({ increment })

          for (const [key, item] of this.localFilesMap) {
            if (item.ignore) {
              log.info(`<updateAll> ignored. (${item.filePath})`)
              continue
            }
            if (!item.namespace) {
              log.error(`<updateAll> namespace is undefined. (${item.filePath})`, false)
              continue
            }
            const swaggerItem = (this.viewList.interFacePathNameMap.get(item.namespace) as unknown) as TreeInterface
            if (!swaggerItem) {
              log.error(`<updateAll> swaggerItem is undefined. (${item.filePath})`, false)
              continue
            }

            await this.viewList
              .saveInterface(swaggerItem, item.filePath)
              .then((res) => {
                if (res === 'no-change') {
                  return log.info(`${localize.getLocalize('text.noChange')} <${item.name}> `)
                }
                log.info(
                  `${localize.getLocalize('command.local.updateInterface')} <${item.name}> ${localize.getLocalize(
                    'success'
                  )}`
                )
              })
              .catch((err) => {
                log.error(
                  `${localize.getLocalize('command.local.updateInterface')} <${item.name}> ${localize.getLocalize(
                    'failed'
                  )} ${err}`,
                  true
                )
              })

            progress.report({ increment, message: key })
            increment += unit
          }

          resolve(void 0)
        })
      }
    )

    progressPanel.then(() => {
      this.statusBarItem.text = statusBarItemText
      this.statusBarItem.command = 'cmd.local.updateAll'
      this.initLocalFiles()
      log.info(`${localize.getLocalize('text.updateButtonTooltips')} ${localize.getLocalize('success')}`)
      log.outputChannel.show()
    })
  }

  /** 刷新单个本地接口 */
  public updateSingle(filePath: string) {
    const fileInfo = this.readLocalFile(filePath)

    if (fileInfo && fileInfo.ext === 'ts') {
      this.localFilesMap.set(fileInfo.fileName, fileInfo)
      this.refactorLocalFilesList()
    }
  }

  getChildren(): Thenable<LocalItem[]> {
    const treeItems = this.renderItems(this.localFilesList)

    return Promise.resolve(treeItems)
  }

  renderItems(itemList: FileHeaderInfo[]): LocalItem[] {
    return itemList.map(this.renderItem)
  }

  renderItem(item: FileHeaderInfo) {
    const title = item.name || item.namespace || item.fileName

    const options: BaseTreeItemOptions & ExtLocalItemOptions = {
      title,
      type: item.ignore ? 'file-ignore' : 'file-sync',
      subTitle: `[${item.update || 'No Update Date'}] <${item.namespace}> ${item.path}`,
      collapsible: 0,
      filePath: item.filePath,
      namespace: item.namespace,
      command: {
        title,
        command: 'cmd.common.openFile',
        arguments: [item.filePath],
      },
    }

    return new LocalItem(options)
  }

  getParent() {
    return void 0
  }

  /** 重新生成本地文件列表 */
  public refactorLocalFilesList() {
    this.localFilesList = []
    this.localFilesMap.forEach((val) => {
      this.localFilesList.push(val)
    })
    this._onDidChangeTreeData.fire(undefined)
  }

  /** 刷新 */
  public refresh(): void {
    // 0.5 秒防抖, 避免重复刷新占用大量资源
    this.debounce(() => this._refresh(), 500)
  }

  private _refresh() {
    this.initLocalFiles()
    log.info('refresh: view.local')
  }

  /** settings.json 文件变更时触发 */
  public onConfigurationRefresh() {
    const { savePath } = config.extConfig
    this.localPath = path.resolve(WORKSPACE_PATH || '', savePath)

    this.initStatusBarItem()

    this.refresh()
  }

  /** 销毁时释放资源 */
  destroy(): void {}
}

export class LocalItem extends BaseTreeItem<ExtLocalItemOptions> {}
