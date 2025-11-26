import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { disposeCurrentRecordAndCloseWebview, openGranularityWebview } from '../createview/create-granularity-panel'

// Set a global tree data provider.
let fileTreeProvider: FileTreeProvider | null = null

export class FileNode extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly absolutePath: string,
        public children?: FileNode[]
    ) {
        super(label, collapsibleState)
        this.contextValue = collapsibleState === vscode.TreeItemCollapsibleState.None ? 'leafNode' : 'nonLeafNode'
        
        // Set icon based on node type.
        const iconName = this.collapsibleState === vscode.TreeItemCollapsibleState.None ? 'chrome-maximize' : 'type-hierarchy-sub'
        this.iconPath = new vscode.ThemeIcon(
            iconName,
            new vscode.ThemeColor('charts.blue')
        )
    }
}

export class FileTreeProvider implements vscode.TreeDataProvider<FileNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<FileNode | undefined> = new vscode.EventEmitter<FileNode | undefined>()
    readonly onDidChangeTreeData: vscode.Event<FileNode | undefined> = this._onDidChangeTreeData.event

    constructor(public treeData: FileNode[]) {}

    getTreeItem(element: FileNode): vscode.TreeItem {
        return element
    }

    getChildren(element?: FileNode): Thenable<FileNode[]> {
        if (!element) {
            return Promise.resolve(this.treeData)
        }

        return Promise.resolve(element.children || [])
    }

    // Update the view after changing node data.
    refresh(fileNode: FileNode | undefined) {
        this._onDidChangeTreeData.fire(fileNode)
    }
}

export async function createTreeView(context: vscode.ExtensionContext) {
    
    context.subscriptions.push(
        vscode.commands.registerCommand("CodeToolBox.openChatGPTView", async () => {
            openChatGPTView(context)
        })
    )    
}

const openChatGPTView = (context: vscode.ExtensionContext) => {
    vscode.commands.executeCommand("workbench.view.extension.CodeToolBox").then(() => {
        fileTreeProvider = new FileTreeProvider([])

        const treeView = vscode.window.createTreeView('CodeToolBox.chatGPTView', {
            treeDataProvider: fileTreeProvider 
        })
        
        context.subscriptions.push(treeView)

        // Listen to node selection.
        treeView.onDidChangeSelection(async event => {
            if (fileTreeProvider && event.selection.length === 1) {
                const selected = event.selection[0]
                const filePath = path.join(selected.absolutePath, 'content.txt')

                try {
                    const doc = await vscode.workspace.openTextDocument(filePath)
                    await vscode.window.showTextDocument(doc)
                } catch (error) {
                    console.error(`Failed to open file ${filePath}.`)
                    return
                }

                if (selected.contextValue === 'leafNode') {
                    openGranularityWebview(selected.absolutePath)
                } else {
                    // If non-leaf node, close the granularity panel.
                    disposeCurrentRecordAndCloseWebview()
                }
            }
        })

        // Register commands for deleting node.
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.deleteNode', async (node: FileNode) => {
                if (fileTreeProvider) {
                    // Deleting corresponding folder in fs.
                    try {
                        fs.rmSync(node.absolutePath, { recursive: true, force: true })
                    } catch (error) {
                        vscode.window.showErrorMessage(`Error occurred while deleting node "${node.label}".`)
                        console.error(`Error occurred while deleting node "${node.label}": `, error)
                        return
                    }

                    // Function to recursively find and delete the node from tree data.
                    function removeNode(nodes: FileNode[]) {
                        const index = nodes.indexOf(node)
                        if (index >= 0) {
                            nodes.splice(index, 1)
                            return true
                        }
                        for (const n of nodes) {
                            if (n.children && removeNode(n.children)) return true
                        }
                        return false
                    }

                    removeNode(fileTreeProvider.treeData)
                    fileTreeProvider.refresh(undefined)
                }
            })
        )

        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.createLeafNode', () => {
                createNode()
            })
        )
        
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.createNonLeafNode', () => {
                createNode(true)
            })
        )

        // Callback functions for creating non-leaf and leaf node.
        async function createNode(nonLeaf: boolean = false) {
            if (fileTreeProvider) {
                const selected = treeView.selection[0]
                if (selected && selected.contextValue === 'leafNode') {
                    console.log('Cannot create child for leaf node.')
                    return
                }

                const targetPath =  selected ? selected.absolutePath : vscode.workspace.getConfiguration('ai').get<string>('path')!
                const typeLabel = nonLeaf ? "non-leaf" : "leaf"
                const defaultName = nonLeaf ? "New Non-leaf Node" : "New Leaf Node"

                const newNodeName = await vscode.window.showInputBox({
                    prompt: `Enter new ${typeLabel} node name`,
                    value: defaultName
                })                

                // User cancel.
                if (!newNodeName) return

                // Create target dir and files in fs.
                const newNodePath = path.join(targetPath, newNodeName)
                const filePath = path.join(newNodePath, "content.txt")
                try {
                    if (fs.existsSync(newNodePath)) {
                        vscode.window.showErrorMessage(`Node "${newNodeName}" already exists.`)
                        return
                    }
                    fs.mkdirSync(newNodePath, { recursive: true })
                    fs.writeFileSync(filePath, "Empty node content.")
                } catch (error) {
                    console.error(`Error occurred while creating file "${filePath}".`, error)
                    return
                }

                const itemState = nonLeaf ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                const newNode = new FileNode(
                    newNodeName,
                    itemState,
                    newNodePath
                )

                if (selected) {
                    if (!selected.children) selected.children = []
                    selected.children.push(newNode)
                } else {
                    fileTreeProvider.treeData.push(newNode)
                }

                fileTreeProvider.refresh(undefined)
            }
        }
        
        vscode.commands.executeCommand("setContext", "CodeToolBox.chatGPTView", true)
    })
}

