import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { disposeCurrentRecordAndCloseWebview, openGranularityWebview } from '../granularity-view/create-granularity-panel'
import { GranularityRecord } from '../granularity-view/granularity-record'
import * as openaiHelper from '../openai/openai-helper'


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

    constructor(public treeData: FileNode[]) { }

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

export async function revealTreeItem(nodePath: string) {
    const dir = path.dirname(nodePath)
    openGranularityWebview(dir)
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

                const targetPath = selected ? selected.absolutePath : vscode.workspace.getConfiguration('ai').get<string>('path')!
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
                    try {
                        // 实例化一个临时的 Record 对象指向新目录
                        const record = new GranularityRecord(newNodePath);

                        // 添加第一条记录：指向刚创建的 content.txt
                        const index = record.getCurrentIndex();
                        record.addRecord(filePath, '粒度' + (index + 1), true);

                        // 保存到 node.json 并释放
                        record.dispose();
                    } catch (e) {
                        console.error('初始化粒度记录失败:', e);
                    }
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


// The following functions are exposed to the granularity view module, for handling seq.json file for the whole project.

interface LeafModule {
    relativePath: string,
    status: 'completed' | 'ongoing' | 'pending'
}

export function getModuleSequence(): LeafModule[] {
    const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path')
    if (!aiPath) return []
    
    // 假设 seq.json 位于插件目录下
    const seqPath = 'D:/Directory/code/chatvs/chatvs/seq.json'
    if (fs.existsSync(seqPath)) {
        try {
            const content = fs.readFileSync(seqPath, 'utf8')
            return JSON.parse(content)
        } catch (e) {
            console.error('读取 seq.json 失败:', e)
        }
    }
    return []
}

// Set the module of index id to 'ongoing'.
// That also means setting the preceding modules to 'completed', the later sequence to 'pending'. 
export function setOnGoingModule(id: number) {
    const moduleSequence = getModuleSequence()

    if (id < 0 || id > moduleSequence.length) {
        console.warn("Invalid module index: ", id)
        return
    }

    for (let i = 0; i < moduleSequence.length; i++) {
        if (i < id) {
            moduleSequence[i].status = 'completed'
        } else if (i === id) {
            moduleSequence[i].status = 'ongoing'
        } else {
            moduleSequence[i].status = 'pending'
        }
    }

    // Write the change back to json file.
    const seqPath = 'D:/Directory/code/chatvs/chatvs/seq.json'
    if (fs.existsSync(seqPath)) {
        fs.writeFileSync(seqPath, JSON.stringify(moduleSequence))
    }
}

// --- 辅助函数：原子写入 ---
function writeJsonAtomically(filePath: string, data: any) {
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    const content = JSON.stringify(data, null, 2);
    
    try {
        // 1. 写入临时文件
        fs.writeFileSync(tempPath, content, 'utf8');
        // 2. 重命名（原子操作，覆盖原文件）
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        // 如果出错，尝试清理临时文件
        if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (e) {}
        }
        throw error; // 继续抛出错误
    }
}

// --- 辅助函数：安全读取 ---
function readJsonSafe(filePath: string): any[] {
    if (!fs.existsSync(filePath)) {
        return [];
    }
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return content.trim() ? JSON.parse(content) : [];
    } catch (e) {
        console.error(`读取 JSON 失败: ${filePath}`, e);
        return [];
    }
}

export async function doModuleDivision(currentContentPath: string, isFirstLevel: boolean, context: vscode.ExtensionContext) {
    const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path');
    const modulesPath = context.asAbsolutePath('modules.json');
    const ongoingLeafModulesPath = context.asAbsolutePath('ongoing_leaf_modules.json');

    // --- 1. 准备阶段 ---
    let expectedPrefix = '';
    let prompt: { system: string; user: string };

    // 预读取数据到内存
    let allModules = readJsonSafe(modulesPath);
    let ongoingLeafModules = readJsonSafe(ongoingLeafModulesPath);

    if (isFirstLevel) {
        // 第一层：重置所有列表
        allModules = []; 
        ongoingLeafModules = [];
        
        // 即使是第一层，也可以先清空文件，确保 Prompt 读到的是空数组（如果 Prompt 逻辑需要的话）
        // 或者直接依靠 Prompt 内部逻辑。这里为了保险，先原子写入空数组。
        writeJsonAtomically(modulesPath, []);
        writeJsonAtomically(ongoingLeafModulesPath, []);

        prompt = await openaiHelper.getModuleDivisionPrompt1(currentContentPath, context);
        
        // 计算期望前缀：项目名 + "."
        const projectName = path.basename(path.dirname(currentContentPath));
        expectedPrefix = projectName + '.';
    } else {
        // 非第一层：计算当前模块的点号命名
        const rawModuleName = aiPath ? path.dirname(path.relative(aiPath, currentContentPath)) : path.dirname(currentContentPath);
        // 将路径分隔符统一转换为点号
        const currentModuleName = rawModuleName.split(path.sep).join('.');
        
        expectedPrefix = currentModuleName + '.';

        // 【关键修改 1 & 2】
        // 1. 这里不再提前过滤 ongoingLeafModules。
        // 2. 传递给 Prompt 的是 ongoingLeafModulesPath，而不是 modulesPath。
        // 此时磁盘上的 ongoing_leaf_modules.json 依然包含 currentModuleName，
        // 这样 LLM 就能知道当前系统的完整叶子节点状态，包括正在被划分的这个模块。
        
        const projectName = currentModuleName.split('.')[0];
        const requirementsPath = path.join(aiPath || '', projectName, 'content.txt');
        
        prompt = await openaiHelper.getModuleDivisionPrompt2(ongoingLeafModulesPath, requirementsPath, currentModuleName, context);
    }

    // --- 2. 执行阶段：带重试机制的 LLM 调用 ---
    const MAX_RETRIES = 3;
    let retryCount = 0;
    let result: any[] = [];
    let isValidResult = false;

    while (retryCount < MAX_RETRIES && !isValidResult) {
        if (retryCount > 0) {
            console.log(`[ModuleDivision] 校验失败，正在进行第 ${retryCount} 次重试...`);
        }

        try {
            const resultString = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user);
            const cleanJson = resultString.replace(/```json/g, '').replace(/```/g, '').trim();
            result = JSON.parse(cleanJson);

            if (result && Array.isArray(result) && result.length > 0) {
                // 校验：所有新模块名必须以 "父模块名." 开头
                const allNamesValid = result.every((mod: any) => {
                    return mod.name && mod.name.toString().startsWith(expectedPrefix);
                });

                if (allNamesValid) {
                    isValidResult = true;
                } else {
                    console.warn(`[ModuleDivision] 校验失败: 存在模块名不符合前缀规范 "${expectedPrefix}"`);
                }
            }
        } catch (e) {
            console.error(`[ModuleDivision] 解析或调用出错 (Attempt ${retryCount + 1}):`, e);
        }

        if (!isValidResult) {
            retryCount++;
        }
    }

    if (!isValidResult) {
        vscode.window.showErrorMessage(`模块划分失败：LLM 未能生成符合命名规范("${expectedPrefix}*")的结果。`);
        return [];
    }

    // --- 3. 写入阶段：内存更新 + 物理文件创建 + 原子写入 ---
    const fileNodeList: FileNode[] = [];

    try {
        // 如果不是第一层，现在划分成功了，才从叶子节点列表中移除“父模块”
        if (!isFirstLevel) {
            const rawModuleName = aiPath ? path.dirname(path.relative(aiPath, currentContentPath)) : path.dirname(currentContentPath);
            const currentModuleName = rawModuleName.split(path.sep).join('.');
            ongoingLeafModules = ongoingLeafModules.filter((mod: any) => mod.name !== currentModuleName);
        }

        result.forEach((module: any) => {
            // 将点号命名转换为文件路径
            const moduleRelPath = module.name.split('.').join(path.sep);
            const moduleContentPath = path.join(aiPath || '', moduleRelPath, 'content.txt');

            // 1. 物理文件操作
            fs.mkdirSync(path.dirname(moduleContentPath), { recursive: true });
            fs.writeFileSync(moduleContentPath, JSON.stringify(module, null, 2));

            // 2. 内存数据更新
            allModules.push(module);
            ongoingLeafModules.push(module); // 添加新生成的子模块作为新的叶子

            // 3. 构建返回值
            const itemState = vscode.TreeItemCollapsibleState.None;
            const newNode = new FileNode(
                path.basename(module.name),
                itemState,
                path.dirname(moduleContentPath)
            );
            fileNodeList.push(newNode);
        });

        // 4. 最终提交 (Atomic Write)
        writeJsonAtomically(modulesPath, allModules);
        writeJsonAtomically(ongoingLeafModulesPath, ongoingLeafModules);

    } catch (error) {
        vscode.window.showErrorMessage(`保存模块数据时发生错误: ${error}`);
        console.error(error);
    }

    return fileNodeList;
}

export async function getCommonDS(projectPath: string, context: vscode.ExtensionContext) {
    const requirementsPath = path.join(projectPath, 'content.txt');
    
    // 【修改】改为使用 ongoingLeafModulesPath
    const ongoingLeafModulesPath = context.asAbsolutePath('ongoing_leaf_modules.json');

    // 【修改】传入 ongoingLeafModulesPath
    const prompt = await openaiHelper.getCommonDSPrompt(ongoingLeafModulesPath, requirementsPath, context);
    
    try {
        const resultString = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user);
        const result = JSON.parse(resultString.replace(/```json/g, '').replace(/```/g, '').trim());

        const dsPath = path.join(projectPath, 'common_data_structures.json');
        
        if (result) {
            writeJsonAtomically(dsPath, result);
        }
        return dsPath;
    } catch (error) {
        console.error('生成通用数据结构失败:', error);
        vscode.window.showErrorMessage('生成通用数据结构失败，请查看日志。');
        return '';
    }
}

export async function getLeafModules(projectPath: string, commonDSPath: string, context: vscode.ExtensionContext) {
    const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path');
    const requirementsPath = path.join(projectPath, 'content.txt');
    const ongoingLeafModulesPath = context.asAbsolutePath('ongoing_leaf_modules.json');

    const prompt = await openaiHelper.getLeafModules(ongoingLeafModulesPath, requirementsPath, commonDSPath, context);
    
    try {
        const resultString = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user);
        const result = JSON.parse(resultString.replace(/```json/g, '').replace(/```/g, '').trim());

        const leafModulesPath = context.asAbsolutePath('leaf_modules.json');
        
        if (result) {
            writeJsonAtomically(leafModulesPath, result);
        }
        return leafModulesPath;
    } catch (error) {
        console.error('生成叶子模块列表失败:', error);
        vscode.window.showErrorMessage('生成叶子模块列表失败，请查看日志。');
        return '';
    }
}