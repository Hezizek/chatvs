import * as path from 'path'
import * as fs from 'fs'
import * as settings from '../settings/settings'
import { DesignmentTreeNode, DirectoryNode, FileNode, NodeType } from './designment-tree-data-provider'

export function getlocalNodeTree(): DesignmentTreeNode[] {
    const aiPath = settings.getAiPath()
    const dirs = fs.readdirSync(aiPath, { withFileTypes: true })
    const projectNodes: DesignmentTreeNode[] = []

    dirs.filter(dir => !dir.name.startsWith('_') && dir.isDirectory()).forEach(item => {
        const fullPath = path.join(aiPath, item.name)
        getProjectTreeStructure(fullPath).then(projectNode => {
            projectNodes.push(projectNode)
        })
    })
    return projectNodes
}

async function getProjectTreeStructure(fullPath: string): Promise<DirectoryNode> {
    const projectNode = new DirectoryNode(
        path.basename(fullPath),
        fullPath,
        NodeType.Project
    )    

    // 检查并添加 common_data_structures.json
    if (fs.existsSync(path.join(fullPath, 'common_data_structures.json'))) {
        const dataStructureNode = new FileNode(
            'Common Data Structures', 
            path.join(fullPath, 'common_data_structures.json'),
            NodeType.DataStructure,
            projectNode
        )
        projectNode.children.push(dataStructureNode)
    }
    
    // 检查并添加实际数据结构文件（data_structures.py, data_structures.java 等）
    const dataStructureFiles = fs.readdirSync(fullPath).filter(file => 
        file.startsWith('data_structures.') && !file.endsWith('.json')
    )
    
    dataStructureFiles.forEach(fileName => {
        const actualDSNode = new FileNode(
            'Actual Data Structures',
            path.join(fullPath, fileName),
            NodeType.DataStructure,
            projectNode
        )
        projectNode.children.push(actualDSNode)
    })

    projectNode.children.push(new FileNode(
        'Project Requirements', 
        path.join(fullPath, 'content.txt'),
        NodeType.Requirement,
        projectNode
    ))

    const dirs = fs.readdirSync(fullPath, { withFileTypes: true })
    dirs.filter(dir => !dir.name.startsWith('_') && dir.isDirectory()).forEach(item => {
        const modulePath = path.join(fullPath, item.name)
        parseModule(modulePath).then(moduleNode => {
            moduleNode.parent = projectNode
            projectNode.children.push(moduleNode)
        })
    })

    return projectNode
}


async function parseModule(modulePath: string): Promise<DirectoryNode> {
    const moduleNode = new DirectoryNode(
        path.basename(modulePath),
        modulePath,
        NodeType.Module
    )

    const dirs = fs.readdirSync(modulePath, { withFileTypes: true })
    dirs.filter(dir => !dir.name.startsWith('_') && dir.isDirectory()).forEach(item => {
        const subModulePath = path.join(modulePath, item.name)
        parseModule(subModulePath).then(subModuleNode => {
            subModuleNode.parent = moduleNode
            moduleNode.children.push(subModuleNode)
        })
    })
    
    return moduleNode
}
