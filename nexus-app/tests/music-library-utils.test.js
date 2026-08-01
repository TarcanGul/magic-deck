import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMusicLibraryTree,
  filterMusicEntries,
  flattenMusicLibraryTree,
  findMusicLibraryNode,
  findMusicLibraryParentNode,
  indexMusicDirectory,
  indexMusicFiles,
  musicLibraryTreeKeyAction,
  nextMusicSelectionIndex,
  normalizeLibraryPath,
  recoverMusicLibrarySelectionId,
  sortMusicEntries,
} from '../src/music-library-utils.js'

function mockFile(name, size = 100, lastModified = 1) {
  return { name, size, lastModified, webkitRelativePath: '' }
}

function mockFileHandle(name, file = mockFile(name), shouldFail = false) {
  return {
    kind: 'file',
    name,
    async getFile() {
      if (shouldFail) throw new Error('unreadable')
      return file
    },
  }
}

function mockDirectory(name, children) {
  return {
    kind: 'directory',
    name,
    async *values() {
      yield* children
    },
  }
}

test('recursively indexes supported files and skips unreadable entries', async () => {
  const root = mockDirectory('Music', [
    mockFileHandle('Zulu.wav', mockFile('Zulu.wav', 400, 5)),
    mockFileHandle('notes.txt'),
    mockDirectory('House', [
      mockFileHandle('Alpha.MP3', mockFile('Alpha.MP3', 200, 3)),
      mockFileHandle('missing.wav', mockFile('missing.wav'), true),
    ]),
  ])

  const entries = await indexMusicDirectory(root)
  assert.deepEqual(entries.map(({ relativePath }) => relativePath), [
    'House/Alpha.MP3',
    'Zulu.wav',
  ])
  assert.equal(entries[0].folder, 'House')
  assert.equal(entries[0].size, 200)
})

test('normalizes fallback paths and filters unsupported files', () => {
  const wav = { ...mockFile('Kick.wav'), webkitRelativePath: 'Library\\Drums\\Kick.wav' }
  const files = indexMusicFiles([wav, mockFile('cover.png')])
  assert.equal(normalizeLibraryPath('/Library//Drums/Kick.wav'), 'Library/Drums/Kick.wav')
  assert.deepEqual(files.map(({ relativePath }) => relativePath), ['Drums/Kick.wav'])
  assert.equal(files[0].folder, 'Drums')
  assert.equal(files[0].file, wav)
})

test('searches paths case-insensitively and sorts deterministic columns', () => {
  const entries = [
    { id: 'b', name: 'Track 10.wav', folder: 'Techno', relativePath: 'Techno/Track 10.wav', size: 20, lastModified: 2 },
    { id: 'a', name: 'track 2.wav', folder: 'House', relativePath: 'House/track 2.wav', size: 10, lastModified: 1 },
  ]
  assert.deepEqual(filterMusicEntries(entries, 'HOUSE').map(({ id }) => id), ['a'])
  assert.deepEqual(sortMusicEntries(entries, 'name', 'ascending').map(({ id }) => id), ['a', 'b'])
  assert.deepEqual(sortMusicEntries(entries, 'size', 'descending').map(({ id }) => id), ['b', 'a'])
})

test('moves keyboard selection without wrapping', () => {
  assert.equal(nextMusicSelectionIndex(0, 'ArrowUp', 8), 0)
  assert.equal(nextMusicSelectionIndex(0, 'ArrowDown', 8), 1)
  assert.equal(nextMusicSelectionIndex(6, 'PageUp', 8, 3), 3)
  assert.equal(nextMusicSelectionIndex(1, 'PageDown', 8, 3), 4)
  assert.equal(nextMusicSelectionIndex(2, 'Home', 8), 0)
  assert.equal(nextMusicSelectionIndex(2, 'End', 8), 7)
  assert.equal(nextMusicSelectionIndex(0, 'ArrowDown', 0), -1)
})

function entry(relativePath, size = 10, lastModified = 1) {
  const parts = relativePath.split('/')
  return {
    id: relativePath,
    name: parts.at(-1),
    folder: parts.slice(0, -1).join('/'),
    relativePath,
    size,
    lastModified,
    fileHandle: null,
    file: mockFile(parts.at(-1), size, lastModified),
  }
}

test('builds a deduplicated nested tree and omits folders without tracks', () => {
  const tree = buildMusicLibraryTree([
    entry('Sets/House/One.wav', 20, 2),
    entry('Sets/House/Two.mp3', 30, 4),
    entry('Sets/Techno/Three.wav', 40, 3),
    entry('Loose.wav', 5, 1),
  ])

  assert.deepEqual(tree.map(({ id }) => id), ['Sets', 'Loose.wav'])
  const sets = findMusicLibraryNode(tree, 'Sets')
  assert.equal(sets.kind, 'folder')
  assert.deepEqual(sets.children.map(({ id }) => id), ['Sets/House', 'Sets/Techno'])
  assert.equal(sets.size, 90)
  assert.equal(sets.lastModified, 4)
  assert.equal(findMusicLibraryParentNode(tree, 'Sets/House/One.wav').id, 'Sets/House')
  assert.equal(findMusicLibraryParentNode(tree, 'Loose.wav'), null)
  assert.equal(findMusicLibraryNode(tree, 'Empty'), null)
})

test('flattens folders first with independent sibling sorting and expansion', () => {
  const tree = buildMusicLibraryTree([
    entry('B Folder/Tiny.wav', 1, 1),
    entry('A Folder/Large.wav', 50, 4),
    entry('Zulu.wav', 20, 2),
    entry('Alpha.wav', 30, 3),
  ])
  const collapsed = flattenMusicLibraryTree(tree, {
    sortKey: 'size',
    sortDirection: 'descending',
  })
  assert.deepEqual(collapsed.map(({ node }) => node.id), [
    'A Folder',
    'B Folder',
    'Alpha.wav',
    'Zulu.wav',
  ])

  const expanded = flattenMusicLibraryTree(tree, {
    expandedFolderIds: new Set(['A Folder']),
    sortKey: 'name',
    sortDirection: 'ascending',
  })
  assert.deepEqual(expanded.map(({ node, depth }) => [node.id, depth]), [
    ['A Folder', 0],
    ['A Folder/Large.wav', 1],
    ['B Folder', 0],
    ['Alpha.wav', 0],
    ['Zulu.wav', 0],
  ])
})

test('global search includes and temporarily expands only matching ancestors', () => {
  const tree = buildMusicLibraryTree([
    entry('Sets/House/Match Me.wav'),
    entry('Sets/House/Other.wav'),
    entry('Sets/Techno/Nope.wav'),
    entry('Root Match.mp3'),
  ])
  const expanded = new Set(['Sets/Techno'])
  const results = flattenMusicLibraryTree(tree, {
    expandedFolderIds: expanded,
    query: 'match',
  })
  assert.deepEqual(results.map(({ node, expanded }) => [node.id, expanded]), [
    ['Sets', true],
    ['Sets/House', true],
    ['Sets/House/Match Me.wav', false],
    ['Root Match.mp3', false],
  ])
  assert.deepEqual([...expanded], ['Sets/Techno'])
})

test('returns tree navigation actions for movement, folders, and tracks', () => {
  const tree = buildMusicLibraryTree([
    entry('Folder/Child/Track.wav'),
    entry('Folder/Second.wav'),
    entry('Root.wav'),
  ])
  const collapsed = flattenMusicLibraryTree(tree)
  assert.deepEqual(musicLibraryTreeKeyAction(collapsed, 'Folder', 'ArrowRight'), {
    type: 'expand', id: 'Folder',
  })
  assert.deepEqual(musicLibraryTreeKeyAction(collapsed, 'Folder', 'Enter'), {
    type: 'expand', id: 'Folder',
  })

  const visible = flattenMusicLibraryTree(tree, {
    expandedFolderIds: new Set(['Folder', 'Folder/Child']),
  })
  assert.deepEqual(musicLibraryTreeKeyAction(visible, 'Folder', 'ArrowRight'), {
    type: 'select', id: 'Folder/Child',
  })
  assert.deepEqual(musicLibraryTreeKeyAction(visible, 'Folder/Child', 'ArrowLeft'), {
    type: 'collapse', id: 'Folder/Child',
  })
  assert.deepEqual(musicLibraryTreeKeyAction(visible, 'Folder', 'Enter'), {
    type: 'collapse', id: 'Folder',
  })
  assert.deepEqual(musicLibraryTreeKeyAction(visible, 'Folder/Second.wav', 'ArrowLeft'), {
    type: 'select', id: 'Folder',
  })
  assert.deepEqual(musicLibraryTreeKeyAction(visible, 'Folder/Second.wav', 'Enter'), {
    type: 'activate', id: 'Folder/Second.wav',
  })
  assert.equal(musicLibraryTreeKeyAction(visible, 'Folder', 'End').id, 'Root.wav')
  assert.equal(musicLibraryTreeKeyAction(visible, 'Root.wav', 'Home').id, 'Folder')
  assert.equal(musicLibraryTreeKeyAction(visible, 'Root.wav', 'PageUp', 2).id, 'Folder/Child/Track.wav')
})

test('recovers hidden selection and keeps expansion state independent per deck', () => {
  const tree = buildMusicLibraryTree([
    entry('Folder/Child/Track.wav'),
    entry('Root.wav'),
  ])
  const deckAExpanded = new Set(['Folder'])
  const deckBExpanded = new Set()
  const deckA = flattenMusicLibraryTree(tree, { expandedFolderIds: deckAExpanded })
  const deckB = flattenMusicLibraryTree(tree, { expandedFolderIds: deckBExpanded })

  assert.deepEqual(deckA.map(({ node }) => node.id), ['Folder', 'Folder/Child', 'Root.wav'])
  assert.deepEqual(deckB.map(({ node }) => node.id), ['Folder', 'Root.wav'])
  assert.equal(recoverMusicLibrarySelectionId('Folder/Child/Track.wav', deckA), 'Folder/Child')
  assert.equal(recoverMusicLibrarySelectionId('Missing/Track.wav', deckB), 'Folder')
})
