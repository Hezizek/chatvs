import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { DesignmentTreeNode, DirectoryNode, FileNode, NodeType } from './designment-tree-data-provider'
import * as openaiHelper from '../openai/openai-helper'

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

// Given a node in the tree, find the project root path.
function getProjectRootPath(element: DesignmentTreeNode): string {
    while (element.parent) {
        element = element.parent
    }
    return element.absolutePath
}

export async function doModuleDivision(targetNode: DirectoryNode, context: vscode.ExtensionContext) {

    const aiPath = vscode.workspace.getConfiguration('ai').get<string>('path')
    const projectRootPath = getProjectRootPath(targetNode)
    const modulesPath = path.join(projectRootPath, 'modules.json')
    const ongoingLeafModulesPath = path.join(projectRootPath, 'ongoing_leaf_modules.json')
    console.log('[ModuleDivision] Target Node Path:', ongoingLeafModulesPath) // test
    const currentContentPath = targetNode.getContentFilePath()

    const isFirstLevel = targetNode.type === NodeType.Project

    // --- 1. 准备阶段 ---
    let expectedPrefix = ''
    let prompt: { system: string, user: string }

    // 预读取数据到内存
    let allModules = readJsonSafe(modulesPath);
    let ongoingLeafModules = readJsonSafe(ongoingLeafModulesPath);

    if (isFirstLevel) {
        // 第一层：重置所有列表
        allModules = [] 
        ongoingLeafModules = []
        
        // 即使是第一层，也可以先清空文件，确保 Prompt 读到的是空数组（如果 Prompt 逻辑需要的话）
        // 或者直接依靠 Prompt 内部逻辑。这里为了保险，先原子写入空数组。
        writeJsonAtomically(modulesPath, [])
        writeJsonAtomically(ongoingLeafModulesPath, [])

        prompt = await openaiHelper.getModuleDivisionPrompt1(currentContentPath, context)
        
        // 计算期望前缀：项目名 + "."
        const projectName = path.basename(path.dirname(currentContentPath))
        expectedPrefix = projectName + '.'
    } else {
        // 非第一层：计算当前模块的点号命名
        const rawModuleName = aiPath ? path.dirname(path.relative(aiPath, currentContentPath)) : path.dirname(currentContentPath)
        // 将路径分隔符统一转换为点号
        const currentModuleName = rawModuleName.split(path.sep).join('.')
        
        expectedPrefix = currentModuleName + '.'

        // 【关键修改 1 & 2】
        // 1. 这里不再提前过滤 ongoingLeafModules。
        // 2. 传递给 Prompt 的是 ongoingLeafModulesPath，而不是 modulesPath。
        // 此时磁盘上的 ongoing_leaf_modules.json 依然包含 currentModuleName，
        // 这样 LLM 就能知道当前系统的完整叶子节点状态，包括正在被划分的这个模块。
        
        const projectName = currentModuleName.split('.')[0]
        const requirementsPath = path.join(aiPath || '', projectName, 'content.txt')
        
        prompt = await openaiHelper.getModuleDivisionPrompt2(ongoingLeafModulesPath, requirementsPath, currentModuleName, context)
    }

    // --- 2. 执行阶段：带重试机制的 LLM 调用 ---
    const MAX_RETRIES = 3
    let retryCount = 0
    let result: any[] = []
    let isValidResult = false

    while (retryCount < MAX_RETRIES && !isValidResult) {
        if (retryCount > 0) {
            console.log(`[ModuleDivision] 校验失败，正在进行第 ${retryCount} 次重试...`)
        }

        try {
            const resultString = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user)
            const cleanJson = resultString.replace(/```json/g, '').replace(/```/g, '').trim()
            result = JSON.parse(cleanJson)

            if (result && Array.isArray(result) && result.length > 0) {
                // 校验：所有新模块名必须以 "父模块名." 开头
                const allNamesValid = result.every((mod: any) => {
                    return mod.name && mod.name.toString().startsWith(expectedPrefix)
                })

                if (allNamesValid) {
                    isValidResult = true
                } else {
                    console.warn(`[ModuleDivision] 校验失败: 存在模块名不符合前缀规范 "${expectedPrefix}"`)
                }
            }
        } catch (e) {
            console.error(`[ModuleDivision] 解析或调用出错 (Attempt ${retryCount + 1}):`, e)
        }

        if (!isValidResult) {
            retryCount++
        }
    }

    if (!isValidResult) {
        vscode.window.showErrorMessage(`模块划分失败：LLM 未能生成符合命名规范("${expectedPrefix}*")的结果。`)
        return
    }

    // --- 3. 写入阶段：内存更新 + 物理文件创建 + 原子写入 ---
    try {
        // 如果不是第一层，现在划分成功了，才从叶子节点列表中移除“父模块”
        if (!isFirstLevel) {
            const rawModuleName = aiPath ? path.dirname(path.relative(aiPath, currentContentPath)) : path.dirname(currentContentPath)
            const currentModuleName = rawModuleName.split(path.sep).join('.')
            ongoingLeafModules = ongoingLeafModules.filter((mod: any) => mod.name !== currentModuleName)
        }

        result.forEach((module: any) => {
            // 将点号命名转换为文件路径
            console.log('[ModuleDivision] 生成模块：', module.name) // test
            const moduleRelPath = module.name.split('.').join(path.sep)
            const moduleContentPath = path.join(aiPath || '', moduleRelPath, 'content.txt')

            // 1. 物理文件操作
            fs.mkdirSync(path.dirname(moduleContentPath), { recursive: true })
            fs.writeFileSync(moduleContentPath, JSON.stringify(module, null, 2))

            // 2. 内存数据更新
            allModules.push(module)
            ongoingLeafModules.push(module) // 添加新生成的子模块作为新的叶子

            // 3. 构建返回值
            const newNode = new DirectoryNode(
                path.basename(module.name),
                path.dirname(moduleContentPath),
                NodeType.Module,
                targetNode
            )
            targetNode.children.push(newNode)
        })

        // 4. 最终提交 (Atomic Write)
        writeJsonAtomically(modulesPath, allModules)
        writeJsonAtomically(ongoingLeafModulesPath, ongoingLeafModules)

    } catch (error) {
        vscode.window.showErrorMessage(`保存模块数据时发生错误: ${error}`)
        console.error(error)
    }
}

export async function getCommonDS(
    targetNode: DirectoryNode,
    context: vscode.ExtensionContext
) {
    const projectPath = targetNode.absolutePath
    const requirementsPath = path.join(projectPath, 'content.txt')
    
    // 【修改】改为使用 ongoingLeafModulesPath
    const ongoingLeafModulesPath = path.join(projectPath, 'ongoing_leaf_modules.json')

    // 【修改】传入 ongoingLeafModulesPath
    const prompt = await openaiHelper.getCommonDSPrompt(ongoingLeafModulesPath, requirementsPath, context)
    
    try {
        const resultString = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user)
        const result = JSON.parse(resultString.replace(/```json/g, '').replace(/```/g, '').trim())

        const dsPath = path.join(projectPath, 'common_data_structures.json')
        
        if (result) {
            writeJsonAtomically(dsPath, result)
        }
        
        const commonDSNode = new FileNode(
            'Common Data Structures',
            dsPath,
            NodeType.DataStructure,
            targetNode
        )

        targetNode.children.unshift(commonDSNode)

    } catch (error) {
        console.error('生成通用数据结构失败:', error)
        vscode.window.showErrorMessage('生成通用数据结构失败，请查看日志。')
    }
}

export async function getLeafModules(
    projectPath: string,
    context: vscode.ExtensionContext
) {
    const requirementsPath = path.join(projectPath, 'content.txt')
    const ongoingLeafModulesPath = path.join(projectPath, 'ongoing_leaf_modules.json')
    const commonDSPath = path.join(projectPath, 'common_data_structures.json')

    const prompt = await openaiHelper.getLeafModules(ongoingLeafModulesPath, requirementsPath, commonDSPath, context)
    
    try {
        const resultString = await openaiHelper.callOpenAIForJSON(prompt.system, prompt.user)
        const result = JSON.parse(resultString.replace(/```json/g, '').replace(/```/g, '').trim())

        const leafModulesPath = path.join(projectPath, 'leaf_modules.json')
        
        if (result) {
            writeJsonAtomically(leafModulesPath, result)
        }
    } catch (error) {
        console.error('生成叶子模块列表失败:', error)
        vscode.window.showErrorMessage('生成叶子模块列表失败，请查看日志。')
    }
}