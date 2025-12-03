
export function topoSortLeafModules(rawList: any[]): any[] {
    // Map module_name to item.
    const nodeMap = new Map<string, any>();
    for (const item of rawList) {
        nodeMap.set(item.module_name, item);
    }

    // Topological sort result.
    const result: any[] = [];

    // DFS visit state: 'visiting' means in recursion stack; 'visited' means processed.
    const state = new Map<string, 'visiting' | 'visited'>();

    function dfs(moduleName: string) {
        const st = state.get(moduleName);

        if (st === 'visiting') {
            // Cycle detected in recursion stack.
            throw new Error(`Topological sort failed: cycle detected involving module: ${moduleName}`);
        }
        if (st === 'visited') return; // Already processed

        const node = nodeMap.get(moduleName);
        if (!node) {
            throw new Error(`Dependency not found: ${moduleName}`);
        }

        state.set(moduleName, 'visiting');

        // Recursively process dependencies
        for (const dep of node.dependencies ?? []) {
            dfs(dep);
        }

        state.set(moduleName, 'visited');
        result.push(node);
    }

    for (const item of rawList) {
        dfs(item.module_name);
    }

    return result;
}
