import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { DesignmentTreeNode, DirectoryNode, FileNode, NodeType } from './designment-tree-data-provider'
import { topoSortLeafModules } from '../tools/module-topology-util'
import * as designmentService from './designment-tree-service'
import * as openaiHelper from '../openai/openai-helper'
import * as settings from '../settings/settings'

function writeJsonAtomically(filePath: string, data: any) {
    const tempPath = `${filePath}.tmp.${Date.now()}`
    const content = JSON.stringify(data, null, 2)
    
    try {
        fs.writeFileSync(tempPath, content, 'utf8')
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (e) {}
        }
        throw error
    }
}

function readJsonSafe(filePath: string): any[] {
    if (!fs.existsSync(filePath)) {
        return []
    }
    try {
        const content = fs.readFileSync(filePath, 'utf8')
        return content.trim() ? JSON.parse(content) : []
    } catch (e) {
        console.error(`读取 JSON 失败: ${filePath}`, e)
        return []
    }
}

// Given a node in the tree, find the project root path.
function getProjectRootPath(element: DesignmentTreeNode): string {
    while (element.parent) {
        element = element.parent
    }
    return element.absolutePath
}

export async function doModuleDivision(
    parent: DirectoryNode, 
    context: vscode.ExtensionContext
) {

    const aiPath = settings.getAiPath()
    const projectRootPath = getProjectRootPath(parent)
    const modulesPath = path.join(projectRootPath, 'modules.json')
    const ongoingLeafModulesPath = path.join(projectRootPath, 'ongoing_leaf_modules.json')
    const currentContentPath = parent.getContentFilePath()
    const isFirstLevel = parent.type === NodeType.Project

    let expectedPrefix = ''
    let prompt: { system: string, user: string }

    let allModules = readJsonSafe(modulesPath);
    let ongoingLeafModules = readJsonSafe(ongoingLeafModulesPath)

    if (isFirstLevel) {
        // 第一层：重置所有列表
        allModules = [] 
        ongoingLeafModules = []
        
        // 即使是第一层，也可以先清空文件，确保 Prompt 读到的是空数组（如果 Prompt 逻辑需要的话）
        // 或者直接依靠 Prompt 内部逻辑。这里为了保险，先原子写入空数组。
        writeJsonAtomically(modulesPath, [])
        writeJsonAtomically(ongoingLeafModulesPath, [])

        prompt = await openaiHelper.getModuleDivisionPrompt1(currentContentPath, context)
        
        const projectName = path.basename(path.dirname(currentContentPath))
        expectedPrefix = projectName + '.'
    } else {

        const rawModuleName = path.dirname(path.relative(aiPath, currentContentPath))
        const currentModuleName = rawModuleName.split(path.sep).join('.')
        
        expectedPrefix = currentModuleName + '.'

        const projectName = currentModuleName.split('.')[0]
        const requirementsPath = path.join(aiPath, projectName, 'content.txt')
        
        prompt = await openaiHelper.getModuleDivisionPrompt2(ongoingLeafModulesPath, requirementsPath, currentModuleName, context)
    }

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

    try {
        // 如果不是第一层，现在划分成功了，才从叶子节点列表中移除“父模块”
        if (!isFirstLevel) {
            const rawModuleName = path.dirname(path.relative(aiPath, currentContentPath))
            const currentModuleName = rawModuleName.split(path.sep).join('.')
            ongoingLeafModules = ongoingLeafModules.filter((mod: any) => mod.name !== currentModuleName)
        }

        result.forEach((module: any) => {

            allModules.push(module)
            ongoingLeafModules.push(module)

            designmentService.createModule(
                parent, 
                module.name.split('.').pop(),
                JSON.stringify(module, null, 2)
            )
        })

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
    const ongoingLeafModulesPath = path.join(projectPath, 'ongoing_leaf_modules.json')
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

        result.forEach((item: any, index: any) => {
            item.status = index === 0 ? 'ongoing' : 'pending';
        });

        // Currently, we assume that the topology sequence is fixed after designment stage.
        const sortedResult = topoSortLeafModules(result)

        const leafModulesPath = path.join(projectPath, 'leaf_modules.json')
        
        if (sortedResult) {
            writeJsonAtomically(leafModulesPath, sortedResult)
        }
    } catch (error) {
        console.error('生成叶子模块列表失败:', error)
        vscode.window.showErrorMessage('生成叶子模块列表失败，请查看日志。')
    }
}