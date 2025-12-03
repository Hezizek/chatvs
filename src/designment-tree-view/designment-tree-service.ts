import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as settings from '../settings/settings'
import { DesignmentTreeDataProvider, DirectoryNode, FileNode, NodeType } from './designment-tree-data-provider'
import { GranularityNode } from '../granularity-view/granularity-record'


export async function createModule(
    parent: DirectoryNode,
    label: string,
    content?: string
) {
    const absolutePath = path.join(parent.absolutePath, label)
    if (parent.children.find(child => child.absolutePath === absolutePath)) {
        vscode.window.showErrorMessage(`当前父模块下已存在同名子模块 ${label}，请更换模块名称。`)
        return
    }

    const filePath = path.join(absolutePath, 'content.txt')
    // When adding a new leaf module, always initialize a json file with granularity zero.
    const jsonPath = path.join(absolutePath, 'node.json')

    try {
        fs.mkdirSync(absolutePath, { recursive: true })
        if (!fs.existsSync(filePath)) { // test
            fs.writeFileSync(filePath, content ? content : 'Empty content.', 'utf8')
        }

        const firstGranulairty: GranularityNode = {
            index: 1,
            description: '粒度 0',
            filePath: filePath,
            isActive: true
        }

        if (!fs.existsSync(jsonPath))  // test
            fs.writeFileSync(jsonPath, JSON.stringify([firstGranulairty], null, 4), 'utf8')

        // For now the parent is no longer a leaf, so delete its json file.
        if (parent.children.length === 0) {
            const parentJsonPath = path.join(parent.absolutePath, 'node.json')
            if (fs.existsSync(parentJsonPath)) {
                fs.unlinkSync(parentJsonPath)
            }
        }
    } catch (error) {
        vscode.window.showErrorMessage(`创建模块失败: ${error}`)
        throw error
    }

    const newModule = new DirectoryNode(label, absolutePath, NodeType.Module, parent)
    parent.children.push(newModule)
    const dataProvider = DesignmentTreeDataProvider.getInstance()
    dataProvider.refresh(parent)

}


export async function createProject(label: string) {

    const dataProvider = DesignmentTreeDataProvider.getInstance()
    if (dataProvider.localNodeTree.find(child => child.label === label)) {
        vscode.window.showErrorMessage(`已存在同名项目根节点 ${label}，请更换项目名称。`)
        return
    }

    const absolutePath = path.join(settings.getAiPath(), label)
    const filePath = path.join(absolutePath, 'content.txt')

    try {
        fs.mkdirSync(absolutePath, { recursive: true })
        if (!fs.existsSync(filePath)) 
            fs.writeFileSync(filePath, 'Empty content.', 'utf8')
    } catch (error) {
        vscode.window.showErrorMessage(`创建项目失败: ${error}`)
        throw error
    }

    const newProj = new DirectoryNode(label, absolutePath, NodeType.Project)
    const reqModule = new FileNode('Project Requirement', filePath, NodeType.Requirement, newProj)
    newProj.children.push(reqModule)

    dataProvider.localNodeTree.push(newProj)
    dataProvider.refresh(undefined)
}
