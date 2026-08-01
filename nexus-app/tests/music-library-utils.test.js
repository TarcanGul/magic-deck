import test from 'node:test'
import assert from 'node:assert/strict'
import {
  filterMusicEntries,
  indexMusicDirectory,
  indexMusicFiles,
  nextMusicSelectionIndex,
  normalizeLibraryPath,
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
  assert.deepEqual(files.map(({ relativePath }) => relativePath), ['Library/Drums/Kick.wav'])
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
