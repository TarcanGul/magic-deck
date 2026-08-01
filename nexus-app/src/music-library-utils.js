const AUDIO_FILE_PATTERN = /\.(mp3|wav)$/i

export function isSupportedMusicFile(name) {
  return AUDIO_FILE_PATTERN.test(name)
}

export function normalizeLibraryPath(path) {
  return path
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .join('/')
}

function folderFromPath(relativePath) {
  const slash = relativePath.lastIndexOf('/')
  return slash < 0 ? '' : relativePath.slice(0, slash)
}

function fallbackRelativePath(file) {
  const normalizedPath = normalizeLibraryPath(file.webkitRelativePath || file.name)
  if (!file.webkitRelativePath) return normalizedPath
  const parts = normalizedPath.split('/')
  return parts.length > 1 ? parts.slice(1).join('/') : normalizedPath
}

export async function indexMusicDirectory(rootHandle) {
  const entries = []

  async function visit(directory, parentPath) {
    for await (const child of directory.values()) {
      const relativePath = normalizeLibraryPath(
        parentPath ? `${parentPath}/${child.name}` : child.name,
      )
      if (child.kind === 'directory') {
        await visit(child, relativePath)
        continue
      }
      if (child.kind !== 'file' || !isSupportedMusicFile(child.name)) continue
      try {
        const file = await child.getFile()
        entries.push({
          id: relativePath,
          name: child.name,
          folder: folderFromPath(relativePath),
          relativePath,
          size: file.size,
          lastModified: file.lastModified,
          fileHandle: child,
          file: null,
        })
      } catch (_) {
        // A single unreadable or removed file must not prevent the rest of the scan.
      }
    }
  }

  await visit(rootHandle, '')
  return sortMusicEntries(entries, 'name', 'ascending')
}

export function indexMusicFiles(files) {
  const entries = []
  for (const file of files) {
    if (!isSupportedMusicFile(file.name)) continue
    const relativePath = fallbackRelativePath(file)
    entries.push({
      id: relativePath,
      name: file.name,
      folder: folderFromPath(relativePath),
      relativePath,
      size: file.size,
      lastModified: file.lastModified,
      fileHandle: null,
      file,
    })
  }
  return sortMusicEntries(entries, 'name', 'ascending')
}

export function filterMusicEntries(entries, query) {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return [...entries]
  return entries.filter((entry) =>
    entry.relativePath.toLocaleLowerCase().includes(normalizedQuery),
  )
}

export function sortMusicEntries(entries, key, direction) {
  const multiplier = direction === 'descending' ? -1 : 1
  return [...entries].sort((left, right) => {
    const leftValue = key === 'modified' ? left.lastModified : left[key]
    const rightValue = key === 'modified' ? right.lastModified : right[key]
    const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue), undefined, {
        numeric: true,
        sensitivity: 'base',
      })
    if (comparison !== 0) return comparison * multiplier
    return left.relativePath.localeCompare(right.relativePath, undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  })
}

function createFolderNode(name, relativePath, parentId) {
  return {
    kind: 'folder',
    id: relativePath,
    name,
    relativePath,
    parentId,
    size: 0,
    lastModified: 0,
    children: [],
  }
}

export function buildMusicLibraryTree(entries) {
  const roots = []
  const folders = new Map()

  for (const entry of entries) {
    const pathParts = normalizeLibraryPath(entry.relativePath).split('/')
    if (pathParts.length === 0) continue
    let children = roots
    let parentId = null
    let folderPath = ''

    for (const folderName of pathParts.slice(0, -1)) {
      folderPath = folderPath ? `${folderPath}/${folderName}` : folderName
      let folder = folders.get(folderPath)
      if (!folder) {
        folder = createFolderNode(folderName, folderPath, parentId)
        folders.set(folderPath, folder)
        children.push(folder)
      }
      children = folder.children
      parentId = folder.id
    }

    children.push({
      ...entry,
      kind: 'track',
      parentId,
    })

    for (let path = parentId; path; path = folders.get(path)?.parentId ?? null) {
      const folder = folders.get(path)
      if (!folder) break
      folder.size += entry.size
      folder.lastModified = Math.max(folder.lastModified, entry.lastModified)
    }
  }

  return roots
}

function compareTreeNodes(left, right, key, direction) {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1
  const multiplier = direction === 'descending' ? -1 : 1
  const leftValue = key === 'modified' ? left.lastModified : left[key]
  const rightValue = key === 'modified' ? right.lastModified : right[key]
  const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
    ? leftValue - rightValue
    : String(leftValue).localeCompare(String(rightValue), undefined, {
      numeric: true,
      sensitivity: 'base',
    })
  if (comparison !== 0) return comparison * multiplier
  return left.relativePath.localeCompare(right.relativePath, undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

function matchingSearchTree(nodes, normalizedQuery) {
  const matches = []
  for (const node of nodes) {
    if (node.kind === 'track') {
      if (node.relativePath.toLocaleLowerCase().includes(normalizedQuery)) matches.push(node)
      continue
    }
    const matchingChildren = matchingSearchTree(node.children, normalizedQuery)
    if (matchingChildren.length > 0) matches.push({ ...node, children: matchingChildren })
  }
  return matches
}

export function flattenMusicLibraryTree(
  nodes,
  {
    expandedFolderIds = new Set(),
    query = '',
    sortKey = 'name',
    sortDirection = 'ascending',
  } = {},
) {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const searchActive = normalizedQuery.length > 0
  const visibleTree = searchActive ? matchingSearchTree(nodes, normalizedQuery) : nodes
  const visible = []

  function visit(siblings, depth) {
    const sortedSiblings = [...siblings].sort((left, right) =>
      compareTreeNodes(left, right, sortKey, sortDirection),
    )
    for (const node of sortedSiblings) {
      const expanded = node.kind === 'folder'
        && (searchActive || expandedFolderIds.has(node.id))
      visible.push({ node, depth, expanded })
      if (node.kind === 'folder' && expanded) visit(node.children, depth + 1)
    }
  }

  visit(visibleTree, 0)
  return visible
}

export function findMusicLibraryNode(nodes, nodeId) {
  for (const node of nodes) {
    if (node.id === nodeId) return node
    if (node.kind === 'folder') {
      const match = findMusicLibraryNode(node.children, nodeId)
      if (match) return match
    }
  }
  return null
}

export function findMusicLibraryParentNode(nodes, nodeId) {
  const node = findMusicLibraryNode(nodes, nodeId)
  if (!node?.parentId) return null
  const parent = findMusicLibraryNode(nodes, node.parentId)
  return parent?.kind === 'folder' ? parent : null
}

export function recoverMusicLibrarySelectionId(selectedId, visibleNodes) {
  if (selectedId && visibleNodes.some(({ node }) => node.id === selectedId)) return selectedId
  if (selectedId) {
    const pathParts = normalizeLibraryPath(selectedId).split('/')
    while (pathParts.length > 1) {
      pathParts.pop()
      const ancestorId = pathParts.join('/')
      if (visibleNodes.some(({ node }) => node.id === ancestorId)) return ancestorId
    }
  }
  return visibleNodes[0]?.node.id ?? null
}

export function musicLibraryTreeKeyAction(
  visibleNodes,
  selectedId,
  key,
  pageSize = 3,
) {
  if (visibleNodes.length === 0) return { type: 'none', id: null }
  const selectedIndex = visibleNodes.findIndex(({ node }) => node.id === selectedId)
  const safeIndex = selectedIndex < 0 ? 0 : selectedIndex
  const current = visibleNodes[safeIndex]

  if (key === 'Enter') {
    return current.node.kind === 'track'
      ? { type: 'activate', id: current.node.id }
      : { type: current.expanded ? 'collapse' : 'expand', id: current.node.id }
  }
  if (key === 'ArrowRight' && current.node.kind === 'folder') {
    if (!current.expanded) return { type: 'expand', id: current.node.id }
    const child = visibleNodes[safeIndex + 1]
    if (child?.node.parentId === current.node.id) return { type: 'select', id: child.node.id }
    return { type: 'none', id: current.node.id }
  }
  if (key === 'ArrowLeft') {
    if (current.node.kind === 'folder' && current.expanded) {
      return { type: 'collapse', id: current.node.id }
    }
    return current.node.parentId
      ? { type: 'select', id: current.node.parentId }
      : { type: 'none', id: current.node.id }
  }
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key)) {
    return { type: 'none', id: current.node.id }
  }
  const nextIndex = nextMusicSelectionIndex(safeIndex, key, visibleNodes.length, pageSize)
  return { type: 'select', id: visibleNodes[nextIndex]?.node.id ?? current.node.id }
}

export function nextMusicSelectionIndex(currentIndex, key, entryCount, pageSize = 3) {
  if (entryCount <= 0) return -1
  const safeIndex = Math.max(0, Math.min(currentIndex, entryCount - 1))
  if (key === 'ArrowUp') return Math.max(0, safeIndex - 1)
  if (key === 'ArrowDown') return Math.min(entryCount - 1, safeIndex + 1)
  if (key === 'Home') return 0
  if (key === 'End') return entryCount - 1
  if (key === 'PageUp') return Math.max(0, safeIndex - Math.max(1, pageSize))
  if (key === 'PageDown') return Math.min(entryCount - 1, safeIndex + Math.max(1, pageSize))
  return safeIndex
}
