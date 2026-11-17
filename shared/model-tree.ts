import type { Model, ModelTreeNode, Project } from './types.ts';

export function nodePartIds(node: ModelTreeNode): string[] { return [...(node.partId ? [node.partId] : []), ...(node.children ?? []).flatMap(nodePartIds)]; }
export function nodeAxisIds(node: ModelTreeNode): string[] { return [...(node.axisId ? [node.axisId] : []), ...(node.children ?? []).flatMap(nodeAxisIds)]; }

/** Older imported models already carry Fusion occurrence paths; retain that hierarchy until metadata is refreshed. */
export function browserRoots(model: Model): ModelTreeNode[] {
  if (model.browserTree) {
    const represented = new Set(model.browserTree.flatMap(nodePartIds));
    const missing = model.parts.filter(part => !represented.has(part.id));
    if (!missing.length) return model.browserTree;
    return [...model.browserTree, { id: 'unlisted-source-parts', kind: 'object', name: missing.every(part => part.sourceStatus === 'removed') ? 'Removed source parts' : 'Additional parts', children: missing.map(part => ({ id: `part:${part.id}`, name: part.name, kind: 'part', partId: part.id })) }];
  }
  const roots: ModelTreeNode[] = [], nodes = new Map<string, ModelTreeNode>();
  const occurrence = (path: string): ModelTreeNode => {
    const saved = nodes.get(path); if (saved) return saved;
    const pieces = path.split('+'), name = pieces.pop()!;
    const node: ModelTreeNode = { id: `object:${path}`, kind: 'object', name, componentPath: path, children: [] };
    nodes.set(path, node); (pieces.length ? occurrence(pieces.join('+')).children! : roots).push(node); return node;
  };
  for (const part of model.parts) {
    const node: ModelTreeNode = { id: `part:${part.id}`, kind: 'part', name: part.name, partId: part.id };
    if (part.sourceStatus === 'removed') { occurrence('Removed source parts').children!.push(node); continue; }
    if (part.objectId === 'fusion-root') roots.push(node); else occurrence(part.objectName || model.name).children!.push(node);
  }
  for (const axis of model.constructionAxes ?? []) {
    const node: ModelTreeNode = { id: `axis:${axis.id}`, kind: 'axis', name: axis.name, axisId: axis.id, visible: axis.visible };
    if (!axis.occurrenceToken) roots.push(node); else occurrence(axis.componentPath).children!.push(node);
  }
  return roots;
}

export function findBrowserNode(model: Model, id: string): ModelTreeNode | undefined {
  const visit = (nodes: ModelTreeNode[]): ModelTreeNode | undefined => {
    for (const node of nodes) { if (node.id === id) return node; const child = visit(node.children ?? []); if (child) return child; }
    return undefined;
  };
  return visit(browserRoots(model));
}

export function nodeOwnVisibility(project: Project, node: ModelTreeNode): boolean {
  if (node.kind === 'object') return project.settings.objectVisibility?.[node.id] ?? node.visible ?? true;
  if (node.partId) return project.settings.partVisibility?.[node.partId] ?? node.visible ?? true;
  if (node.axisId) return project.settings.constructionAxisVisibility?.[node.axisId] ?? project.model.constructionAxes?.find(axis => axis.id === node.axisId)?.visible ?? node.visible ?? true;
  return true;
}

export function modelVisibility(project: Project): { parts: Map<string, boolean>; axes: Map<string, boolean>; objects: Map<string, boolean> } {
  const parts = new Map<string, boolean>(), axes = new Map<string, boolean>(), objects = new Map<string, boolean>();
  const visit = (node: ModelTreeNode, parent: boolean): void => {
    const visible = parent && nodeOwnVisibility(project, node);
    if (node.partId) parts.set(node.partId, visible);
    if (node.axisId) axes.set(node.axisId, visible && project.settings.showConstructionAxes !== false);
    if (node.kind === 'object') objects.set(node.id, visible);
    node.children?.forEach(child => visit(child, visible));
  };
  browserRoots(project.model).forEach(node => visit(node, true)); return { parts, axes, objects };
}
