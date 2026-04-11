import assert from 'assert'
import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import { DesignmentTreeNode, DirectoryNode, NodeType } from './designment-tree-data-provider'
import { topoSortLeafModules } from '../tools/module-topology-util'
import * as designmentService from './designment-tree-service'
import * as openaiHelper from '../openai/openai-helper'
import * as settings from '../settings/settings'
import { ModulesArraySchema, LeafModulesArraySchema, DataStructuresArraySchema, validateModulePrefix } from '../openai/schemas'

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
    context: vscode.ExtensionContext,
    options?: {
        customPrompt?: string
        candidateCount?: number
    }
) {

    const aiPath = settings.getAiPath()
    const projectRootPath = getProjectRootPath(parent)
    const modulesPath = path.join(projectRootPath, 'modules.json')
    const leafModulesPath = path.join(projectRootPath, 'leaf_modules.json')
    const projectName = path.basename(projectRootPath)
    const ongoingLeafModulesPath = path.join(projectRootPath, 'ongoing_leaf_modules.json')
    const currentContentPath = parent.getContentFilePath()
    const isFirstLevel = parent.type === NodeType.Project

    assert(currentContentPath, 'Module division on a node without content file path is not allowed.')

    let expectedPrefix = ''
    let prompt: { system: string, user: string }

    let allModules = readJsonSafe(modulesPath);
    let ongoingLeafModules = readJsonSafe(ongoingLeafModulesPath)
    let leafModules = readJsonSafe(leafModulesPath)

    if (isFirstLevel) {
        // 第一层：重置所有列表
        allModules = [] 
        ongoingLeafModules = []
        
        // 即使是第一层，也可以先清空文件，确保 Prompt 读到的是空数组（如果 Prompt 逻辑需要的话）
        writeJsonAtomically(modulesPath, [])
        writeJsonAtomically(ongoingLeafModulesPath, [])

        prompt = await openaiHelper.getModuleDivisionPrompt1(currentContentPath, context)
        
        expectedPrefix = ''  // 不再要求项目名前缀
    } else {

        const rawModuleName = path.dirname(path.relative(aiPath, currentContentPath))
        const currentModuleName = rawModuleName.split(path.sep).join('.')
        
        // 从 currentModuleName 中移除项目名前缀，用于 expectedPrefix 验证
        const prefixToRemove = projectName + '.';
        const cleanModuleName = currentModuleName.startsWith(prefixToRemove)
            ? currentModuleName.substring(prefixToRemove.length)
            : currentModuleName;
        
        expectedPrefix = cleanModuleName + '.'

        const requirementsPath = path.join(aiPath, projectName, 'content.txt')
        
        prompt = await openaiHelper.getModuleDivisionPrompt2(ongoingLeafModulesPath, requirementsPath, currentModuleName, context)
    }

    const customPrompt = options?.customPrompt?.trim() || ''
    const candidateCount = Math.max(1, Math.min(options?.candidateCount ?? 3, 3))

    async function generateSingleCandidate(extraBias: string): Promise<any[] | null> {
        const MAX_RETRIES = 3
        let retryCount = 0
        let tempPrompt = {
            system: prompt.system,
            user: prompt.user
        }

        if (customPrompt) {
            tempPrompt.user += `\n\n用户补充约束：\n${customPrompt}`
        }

        if (extraBias) {
            tempPrompt.user += `\n\n方案偏向：${extraBias}`
        }

        while (retryCount < MAX_RETRIES) {
            if (retryCount > 0) {
                console.log(`[ModuleDivision] 校验失败，正在进行第 ${retryCount} 次重试...`)
            }

            try {
                const resultString = await openaiHelper.callOpenAIForJSON(
                    tempPrompt.system,
                    tempPrompt.user,
                    ModulesArraySchema,
                    3
                )
                const cleanJson = resultString.replace(/```json/g, '').replace(/```/g, '').trim()
                const parsedResult = JSON.parse(cleanJson)

                const prefixValidation = validateModulePrefix(parsedResult, expectedPrefix)
                if (prefixValidation.valid) {
                    return parsedResult
                }

                console.warn(`[ModuleDivision] 校验失败: 存在模块名不符合前缀规范 "${expectedPrefix}"，不符合的模块: ${prefixValidation.invalidModules.join(', ')}`)
                tempPrompt.user += `\n\n注意：以下模块名称不符合要求，必须以 "${expectedPrefix}" 开头: ${prefixValidation.invalidModules.join(', ')}。请修正。`
            } catch (e) {
                console.error(`[ModuleDivision] 解析或调用出错 (Attempt ${retryCount + 1}):`, e)
            }

            retryCount++
        }

        return null
    }

    const biasPrompts = [
        '优先按职责边界拆分，模块粒度适中。',
        '优先按数据流拆分，强调输入输出清晰。',
        '优先按可测试性拆分，模块职责更单一。'
    ]

    const generatedCandidates: any[][] = []
    for (let i = 0; i < candidateCount; i++) {
        const candidate = await generateSingleCandidate(biasPrompts[i] || '')
        if (candidate) {
            generatedCandidates.push(candidate)
        }
    }

    if (generatedCandidates.length === 0) {
        throw new Error(`模块划分失败：LLM 未能生成符合命名规范("${expectedPrefix}*")的结果。`)
    }

    let result = generatedCandidates[0]
    if (generatedCandidates.length > 1) {
        const picked = await vscode.window.showQuickPick(
            generatedCandidates.map((candidate, index) => ({
                label: `候选方案 ${index + 1}`,
                description: candidate.map((item: any) => item.name).join(' -> '),
                detail: candidate.map((item: any) => `${item.name}: ${item.description}`).join(' | '),
                candidate
            })),
            {
                title: '选择子模块拆分方案',
                placeHolder: '请选择一个候选方案用于替换当前模块',
                ignoreFocusOut: true
            }
        )

        if (!picked) {
            throw new Error('用户取消了候选方案选择。')
        }

        result = picked.candidate
    }

    const pendingRenames: { src: string, dest: string }[] = [];
    const tempFilesToDelete: string[] = [];

    const stageJsonWrite = (targetPath: string, data: any) => {
        const tempPath = `${targetPath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2)}`;
        fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
        tempFilesToDelete.push(tempPath); // 注册以便出错时清理
        pendingRenames.push({ src: tempPath, dest: targetPath }); // 注册待提交的操作
    }

    try {
        await designmentService.resetFinalizedDesignState(projectRootPath)
        // 结构发生变化后必须回到设计阶段，不应继续复用旧的 leaf_modules。
        leafModules = []

        let rawModuleName = ''
        // 如果不是第一层，现在划分成功了，才从叶子节点列表中移除“父模块”
        if (!isFirstLevel) {
            rawModuleName = path.dirname(path.relative(aiPath, currentContentPath))
            
            // 使用 path 字段来匹配删除父模块
            ongoingLeafModules = ongoingLeafModules.filter((mod: any) => {
                const modPath = mod.path ? mod.path.replace(/[\/\\]/g, path.sep) : '';
                return modPath !== rawModuleName;
            })
            
            // 获取父模块的 name（不含项目名）- 从 path 中提取
            const pathParts = rawModuleName.split(path.sep).filter(p => p && p !== projectName);
            const parentModuleName = pathParts.join('.');

            // 更新依赖模块
            const newModuleNames = result.map((m: any) => m.name)
            // 使用 Map 记录受影响模块以去重
            const affectedModules = new Map<string, any>();

            const updateDependencies = (modulesList: any[]) => {
                modulesList.forEach((mod: any) => {
                    // 检查是否依赖被拆分的父模块
                    if (mod.dependencies && Array.isArray(mod.dependencies) && 
                        parentModuleName && mod.dependencies.includes(parentModuleName)) {
                        mod.dependencies = mod.dependencies.filter((d: string) => d !== parentModuleName)
                        newModuleNames.forEach((newName: string) => {
                            if (!mod.dependencies.includes(newName)) {
                                mod.dependencies.push(newName)
                            }
                        })
                        affectedModules.set(mod.name || mod.module_name, mod);
                    }
                })
            }
            updateDependencies(ongoingLeafModules)
            updateDependencies(allModules)
            // 预写入受影响的 content.txt
            affectedModules.forEach((mod, modName) => {
                if (mod.path) {
                    const modContentPath = path.join(aiPath, mod.path, 'content.txt')
                    if (fs.existsSync(modContentPath)) {
                        stageJsonWrite(modContentPath, mod);
                    }
                } else {
                    console.warn(`[ModuleDivision] 模块 ${modName} 缺少 path 属性，跳过更新。`)
                }
            })
        }
        result.forEach((module: any) => {
            module.path = path.join(projectName, module.name.replace(/\./g, path.sep));
            allModules.push(module)
            ongoingLeafModules.push(module)

            designmentService.createModule(
                parent, 
                module.name.split('.').pop(),
                JSON.stringify(module, null, 2)
            )
        })

        if (leafModules.length > 0) {
            if (isFirstLevel) {
                leafModules = result.map((module: any, index: number) => ({
                    module_name: module.name,
                    dependencies: module.dependencies || [],
                    description: module.description || '',
                    status: index === 0 ? 'ongoing' : 'pending',
                    path: path.join(projectName, module.name.replace(/\./g, path.sep))
                }))
            } else {
                const parentIndex = leafModules.findIndex((mod: any) => {
                    const modPath = mod.path ? mod.path.replace(/[\/\\]/g, path.sep) : ''
                    return modPath === rawModuleName
                })

                if (parentIndex >= 0) {
                    const newChildren = result.map((module: any, index: number) => ({
                        module_name: module.name,
                        dependencies: module.dependencies || [],
                        description: module.description || '',
                        status: index === 0 ? 'ongoing' : 'pending',
                        path: path.join(projectName, module.name.replace(/\./g, path.sep))
                    }))

                    leafModules.splice(parentIndex, 1, ...newChildren)
                    leafModules.forEach((mod: any, index: number) => {
                        if (index < parentIndex) {
                            mod.status = 'completed'
                        } else if (index === parentIndex) {
                            mod.status = 'ongoing'
                        } else {
                            mod.status = 'pending'
                        }
                    })
                }
            }
            stageJsonWrite(leafModulesPath, leafModules)
        }

        stageJsonWrite(modulesPath, allModules)
        stageJsonWrite(ongoingLeafModulesPath, ongoingLeafModules)

        pendingRenames.forEach(op => {
            try {
                fs.renameSync(op.src, op.dest)
            } catch (renameError) {
                // 极端情况下的重命名失败 (如文件占用)
                console.error(`Commit failed for ${op.dest}:`, renameError)
                throw renameError
            }
        });

    } catch (error) {
        console.error('Transaction failed, rolling back temp files...', error);
        
        // 清理所有创建的临时文件
        tempFilesToDelete.forEach(p => { 
            if (fs.existsSync(p)) {
                try { fs.unlinkSync(p); } catch(e) {}
            } 
        });

        // [修改] 抛出错误，以便上层捕获
        throw new Error(`保存模块数据时发生错误: ${error}`)
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
        const resultString = await openaiHelper.callOpenAIForJSON(
            prompt.system, 
            prompt.user,
            DataStructuresArraySchema,
            3
        )
        const result = JSON.parse(resultString.replace(/```json/g, '').replace(/```/g, '').trim())

        const dsPath = path.join(projectPath, 'common_data_structures.json')
        
        if (result) {
            writeJsonAtomically(dsPath, result)
        }
        
        const commonDSNode = new DirectoryNode(
            'Common Data Structures',
            dsPath, // TODO
            NodeType.DataStructure,
            targetNode,
            dsPath
        )

        // 将数据结构节点添加到children中，使其在树中可见
        targetNode.children.unshift(commonDSNode)

    } catch (error) {
        console.error('生成通用数据结构失败:', error)
        // [修改] 抛出错误，以便上层捕获
        throw error
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
        const resultString = await openaiHelper.callOpenAIForJSON(
            prompt.system, 
            prompt.user,
            LeafModulesArraySchema,
            3
        )
        const result = JSON.parse(resultString.replace(/```json/g, '').replace(/```/g, '').trim())

        // Currently, we assume that the topology sequence is fixed after designment stage.
        const sortedResult = topoSortLeafModules(result)
        const aiPath = settings.getAiPath()
        const projectName = path.basename(projectPath)

        sortedResult.forEach((item: any, index: any) => {
            item.status = index === 0 ? 'ongoing' : 'pending'

            item.path = path.join(projectName, item.module_name.replace(/\./g, path.sep));

            // Write the designment information to each leaf module.
            const filePath = path.join(
                aiPath,
                item.path,
                'designment_info.txt'
            )

            fs.writeFileSync(filePath, JSON.stringify(item, null, 4), 'utf8')

            const contentPath = path.join(aiPath, item.path, 'content.txt')
            if (fs.existsSync(contentPath)) {
                try {
                    const currentContent = JSON.parse(fs.readFileSync(contentPath, 'utf8'))
                    currentContent.description = item.description || currentContent.description || ''
                    fs.writeFileSync(contentPath, JSON.stringify(currentContent, null, 2), 'utf8')
                } catch {
                    // content.txt is not guaranteed to be JSON in legacy projects.
                }
            }
        })

        const leafModulesPath = path.join(projectPath, 'leaf_modules.json')
        
        if (sortedResult) {
            writeJsonAtomically(leafModulesPath, sortedResult)
        }
    } catch (error) {
        console.error('生成叶子模块列表失败:', error)
        // [修改] 抛出错误，以便上层捕获
        throw error
    }
}