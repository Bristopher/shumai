import { describe, it, expect } from 'vitest'
import { classifyXmp, isXmpSidecar, pickXmpSource } from './xmp-sidecar'

const darktable = (historyEnd: number) => `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="XMP Core 4.4.0-Exiv2">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:darktable="http://darktable.sf.net/"
   xmp:Rating="1" darktable:xmp_version="5" darktable:history_end="${historyEnd}">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`

const lightroom = (hasSettings: boolean) => `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:Version="17.5" crs:HasSettings="${hasSettings ? 'True' : 'False'}" crs:Exposure2012="+0.35">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`

describe('isXmpSidecar', () => {
  it('matches .xmp case-insensitively and nothing else', () => {
    expect(isXmpSidecar('DSCF5056.RAF.xmp')).toBe(true)
    expect(isXmpSidecar('_DSC2028.XMP')).toBe(true)
    expect(isXmpSidecar('DSCF5056.RAF')).toBe(false)
    expect(isXmpSidecar(null)).toBe(false)
  })
})

describe('pickXmpSource', () => {
  const folder = [
    'DSCF5056.JPG',
    'DSCF5056.JPG.xmp',
    'DSCF5056.RAF',
    'DSCF5056.RAF.xmp',
    'notes.txt',
  ]

  it('matches a darktable NAME.EXT.xmp to exactly NAME.EXT', () => {
    expect(pickXmpSource('DSCF5056.RAF.xmp', folder)).toBe('DSCF5056.RAF')
    expect(pickXmpSource('DSCF5056.JPG.xmp', folder)).toBe('DSCF5056.JPG')
  })

  it('matches a Lightroom NAME.xmp to the RAW before the JPEG', () => {
    expect(pickXmpSource('_DSC2028.xmp', ['_DSC2028.JPG', '_DSC2028.ARW'])).toBe('_DSC2028.ARW')
    expect(pickXmpSource('_DSC2028.xmp', ['_DSC2028.JPG'])).toBe('_DSC2028.JPG')
  })

  it('compares names case-insensitively and returns the sibling as named', () => {
    expect(pickXmpSource('dscf5056.raf.XMP', folder)).toBe('DSCF5056.RAF')
  })

  it('returns null when the photo is not there, and ignores other sidecars and non-images', () => {
    expect(pickXmpSource('DSCF9999.RAF.xmp', folder)).toBeNull()
    expect(pickXmpSource('notes.xmp', folder)).toBeNull()
    expect(pickXmpSource('DSCF5056.RAF', folder)).toBeNull()
  })
})

describe('classifyXmp', () => {
  it('reports darktable edits only when the history is non-empty', () => {
    expect(classifyXmp(darktable(0))).toEqual({ editor: 'darktable', hasEdits: false })
    expect(classifyXmp(darktable(7))).toEqual({ editor: 'darktable', hasEdits: true })
  })

  it('does not count darktable auto-applied modules as edits', () => {
    // As written by darktable 5 just from opening a RAF (11 automatic modules) or a JPEG (4).
    const withHashes = (end: number, hashes: string) =>
      darktable(end).replace('darktable:history_end', `${hashes} darktable:history_end`)
    const raf = withHashes(
      11,
      'darktable:history_auto_hash="27ef73b9fa2dbbfc4b810f6c23fba868" darktable:history_current_hash="27ef73b9fa2dbbfc4b810f6c23fba868"',
    )
    const jpg = withHashes(
      4,
      'darktable:history_basic_hash="33e4711b8f6644f5f8c2a164fa3f94cd" darktable:history_current_hash="33e4711b8f6644f5f8c2a164fa3f94cd"',
    )
    const edited = withHashes(
      14,
      'darktable:history_auto_hash="27ef73b9fa2dbbfc4b810f6c23fba868" darktable:history_current_hash="9b1f0c2e44aa0d5e7c3b6a1f2e8d4c70"',
    )
    expect(classifyXmp(raf).hasEdits).toBe(false)
    expect(classifyXmp(jpg).hasEdits).toBe(false)
    expect(classifyXmp(edited).hasEdits).toBe(true)
  })

  it('reports Lightroom edits from crs:HasSettings', () => {
    expect(classifyXmp(lightroom(true))).toEqual({ editor: 'lightroom', hasEdits: true })
    expect(classifyXmp(lightroom(false))).toEqual({ editor: 'lightroom', hasEdits: false })
  })

  it('treats anything else as an unknown editor with no edits', () => {
    expect(classifyXmp('<x:xmpmeta><rdf:RDF/></x:xmpmeta>')).toEqual({
      editor: 'unknown',
      hasEdits: false,
    })
  })
})
