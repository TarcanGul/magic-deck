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
    const relativePath = normalizeLibraryPath(file.webkitRelativePath || file.name)
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
