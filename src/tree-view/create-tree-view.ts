import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { assert } from '../tools/asserts'
import { disposeCurrentRecordAndCloseWebview, openGranularityWebview } from '../granularity-view/create-granularity-panel'
import { GranularityRecord } from '../granularity-view/granularity-record'
import * as openaiHelper from '../openai/openai-helper'


// Set a global tree data provider.
let fileTreeProvider: FileTreeProvider | null = null

// The actual tree structure data stored in memory.
const localNodeTree: NodeTreeElement[] = []

enum NodeType {
    Project,
    Module,
    Requirement,
    DataStructure
}

abstract class NodeTreeElement {
    constructor(
        public label: string,
        public absolutePath: string,
        public type: NodeType,
        public parent?: DirectoryNode,
    ) {}

    abstract getContentFilePath(): string
    abstract isRefinable(): boolean
    abstract isDividable(): this is DirectoryNode
    abstract isExtendable(): boolean
    abstract isLeaf(): boolean

    public getBrothers(): NodeTreeElement[] {
        return this.parent ? this.parent.children : localNodeTree
    }

    public getTypeString(): string {
        return NodeType[this.type]
    }
}

class FileNode extends NodeTreeElement {
    constructor(
        label: string,
        absolutePath: string,
        type: NodeType.Requirement | NodeType.DataStructure,
        parent?: DirectoryNode,
    ) {
        super(label, absolutePath, type, parent)
    }   

    getContentFilePath(): string {
        return this.absolutePath
    }

    isRefinable(): boolean {
        return false
    }

    isDividable(): this is DirectoryNode {
        return false
    }

    isExtendable(): boolean {
        return false
    }

    isLeaf(): boolean {
        return true
    }
}

class DirectoryNode extends NodeTreeElement {
    public children: NodeTreeElement[]
    constructor(
        label: string,
        absolutePath: string,
        type: NodeType.Project | NodeType.Module,
        parent?: DirectoryNode,
        children?: NodeTreeElement[]
    ) {
        super(label, absolutePath, type, parent)
        this.children = children || []
    }

    getContentFilePath(): string {
        return path.join(this.absolutePath, 'content.txt')
    }

    isRefinable(): boolean {
        return this.type === NodeType.Module && this.children.length === 0
    }

    isDividable(): this is DirectoryNode {
        return true
    }

    isExtendable(): boolean {
        return this.children.length > 0
    }

    isLeaf(): boolean {
        return this.children.length === 0
    }
}


export class FileTreeProvider implements vscode.TreeDataProvider<NodeTreeElement> {
    private _onDidChangeTreeData = new vscode.EventEmitter<NodeTreeElement | NodeTreeElement[] | undefined | null>()
    onDidChangeTreeData = this._onDidChangeTreeData.event

    getTreeItem(element: NodeTreeElement): vscode.TreeItem {
        const treeItem = new vscode.TreeItem(element.label, this.getCollapsibleState(element))
        treeItem.contextValue = this.getContextValue(element)
        treeItem.iconPath = this.getIconPath(element)
        return treeItem
    }

    private getCollapsibleState(element: NodeTreeElement): vscode.TreeItemCollapsibleState {
        return element.isExtendable() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    }

    // TODO
    private getIconPath(element: NodeTreeElement): vscode.ThemeIcon {
        switch (element.type) {
            case NodeType.Project:          
                return new vscode.ThemeIcon('project', new vscode.ThemeColor('charts.white'))
            case NodeType.Module:           
                const iconName = element.isLeaf() ? 'circle' : 'type-hierarchy'
                return new vscode.ThemeIcon(iconName, new vscode.ThemeColor('charts.blue'))
            case NodeType.Requirement:      
                return new vscode.ThemeIcon('checklist', new vscode.ThemeColor('charts.yellow'))
            case NodeType.DataStructure:    
                return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.orange'))
            default:
                throw new Error(`Unexpected node type for icon path retrieval: ${NodeType[element.type]}`)
        }
    }

    private getContextValue(element: NodeTreeElement): string {
        const leafContext = element.isLeaf() ? 'leaf' : 'nonLeaf'
        return element.getTypeString() + leafContext
    }

    getChildren(element?: NodeTreeElement): Thenable<NodeTreeElement[]> {
        if (!element) {
            return Promise.resolve(localNodeTree)
        }

        return Promise.resolve(
            element.isDividable() ? element.children : []
        )
    }

    // Update the view after changing node data.
    refresh(fileNode: NodeTreeElement | NodeTreeElement[] | undefined | null) {
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
        fileTreeProvider = new FileTreeProvider()

        const treeView = vscode.window.createTreeView('CodeToolBox.chatGPTView', {
            treeDataProvider: fileTreeProvider
        })

        context.subscriptions.push(treeView)

        // Listen to node selection.
        treeView.onDidChangeSelection(async event => {
            assert(fileTreeProvider, "File tree provider is not initialized.")

            // When single node selected, we need to handle the click event.
            if (event.selection.length === 1) {

                const selected = event.selection[0]
                vscode.commands.executeCommand(
                    "setContext",
                    "CodeToolBox.enableCreateModule",
                    selected.isDividable()
                )

                const contentPath = selected.getContentFilePath()
                const doc = await vscode.workspace.openTextDocument(contentPath)
                await vscode.window.showTextDocument(doc)

                if (selected.isRefinable()) {
                    openGranularityWebview(selected.absolutePath)
                } else {
                    // If non-leaf node, close the granularity panel.
                    disposeCurrentRecordAndCloseWebview()
                }

            } else {
                // Multiple or no selection, disable create module command.
                vscode.commands.executeCommand(
                    "setContext",
                    "CodeToolBox.enableCreateModule",
                    false
                )
            }
        })

        // Register commands for deleting node.
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.deleteNode', async (node: DirectoryNode) => {

                assert(fileTreeProvider, "File tree provider is not initialized.")

                // Deleting corresponding folder in fs.
                fs.rmSync(node.absolutePath, { recursive: true, force: true })

                const parentChildren = node.getBrothers()
                const index = parentChildren.indexOf(node)
                
                assert(index >= 0, 'Node to delete not found in parent\'s children.')
                parentChildren.splice(index, 1)
                fileTreeProvider.refresh(node.parent)
            })
        )

        // Command for creating a new node under existing parent.
        // To be more specific, the node should not be a root node corresponding to a project.
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.createModule', async () => {

                assert(fileTreeProvider, "File tree provider is not initialized.")

                const selected = treeView.selection[0]

                assert(selected, 'No node is selected.')
                assert(selected.isDividable(), 'Selected node is not dividable.')

                const targetPath = selected.absolutePath
                const defaultName = "New Module"

                const newModuleName = await vscode.window.showInputBox({
                    prompt: 'Enter a new module name',
                    value: defaultName
                })

                // User cancel.
                if (!newModuleName) return

                // Create target dir and files in fs.
                const newModulePath = path.join(targetPath, newModuleName)
                const filePath = path.join(newModulePath, "content.txt")
                if (fs.existsSync(newModulePath)) {
                    vscode.window.showErrorMessage(`Module "${newModuleName}" already exists.`)
                    return
                }

                fs.mkdirSync(newModulePath, { recursive: true })
                fs.writeFileSync(filePath, "Empty content.")
        
                // TODO
                // 实例化一个临时的 Record 对象指向新目录
                const record = new GranularityRecord(newModulePath)
                // 添加第一条记录：指向刚创建的 content.txt
                const index = record.getCurrentIndex()
                record.addRecord(filePath, '粒度' + (index + 1), true)

                // 保存到 node.json 并释放
                record.dispose()

                const newNode = new DirectoryNode(newModuleName, newModulePath, NodeType.Module, selected)
                const children = selected.children
                children.push(newNode)

                fileTreeProvider.refresh(selected)
            })
        )

        // Checked.
        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.createProj', async () => {

                assert(fileTreeProvider, "File tree provider is not initialized.")

                const targetPath = vscode.workspace.getConfiguration('ai').get<string>('path')
                const defaultName = "New Project"

                assert(targetPath, "Target file path in settings is not configured.")

                const newProjName = await vscode.window.showInputBox({
                    prompt: 'Enter a new project name',
                    value: defaultName
                })

                // User cancel.
                if (!newProjName) return

                // Create target dir and files in fs.
                const newProjPath = path.join(targetPath, newProjName)
                const filePath = path.join(newProjPath, "content.txt")
                
                if (fs.existsSync(newProjPath)) {
                    vscode.window.showErrorMessage(`Project "${newProjName}" already exists.`)
                    return
                }
                
                fs.mkdirSync(newProjPath, { recursive: true })
                fs.writeFileSync(filePath, "Empty content.")

                const newRoot = new DirectoryNode(newProjName, newProjPath, NodeType.Project)

                // When creating a new project, automtically create a project requirement node under it.
                const reqNode = new FileNode('Project Requirements', filePath, NodeType.Requirement, newRoot)
                newRoot.children.push(reqNode)
                localNodeTree.push(newRoot)
                
                fileTreeProvider.refresh(undefined)
            })
        )

        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.divideRootModule', async (node: NodeTreeElement) => {
                // TODO
            })
        )

        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.divideModule', async (node: NodeTreeElement) => {
                // TODO
            })
        )

        context.subscriptions.push(
            vscode.commands.registerCommand('CodeToolBox.extractCommonDataStructure', async (node: DirectoryNode) => {
                assert(fileTreeProvider, "File tree provider is not initialized.")
                assert(node.type === NodeType.Project, 'Extracting common data structure is only allowed on project nodes.')

                const filePath = path.join(node.absolutePath, 'commen-data-structures.txt')

                fs.writeFileSync(filePath, 'Common Data Structures')
                
                const dataStructureNode = new FileNode(
                    'Common Data Structures',
                    path.join(node.absolutePath, 'commen-data-structures.txt'),
                    NodeType.DataStructure,
                    node
                )

                node.children.unshift(dataStructureNode) 
                fileTreeProvider.refresh(node)
            })
        )

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