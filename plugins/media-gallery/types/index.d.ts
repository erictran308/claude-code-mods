export type MediaKind = 'image' | 'video'

/** One picture or video of a gallery. */
export type MediaItem = {
  /** Absolute. */
  path: string
  name: string
  kind: MediaKind
  /** Size, date and path hashed: what the cached pictures are named by. Empty until read. */
  stamp: string
  /** The thumbnail PNG in the cache; empty until made. */
  thumb: string
  /** The picture's shape, as the thumbnail has it (rotation applied); 0 until read. */
  width: number
  height: number
  /** A video's length; 0 for a picture or when unknown. */
  seconds: number
  bytes: number
  /** Why it cannot be shown; empty when it can. */
  error: string
}

/** What one call of the tool, or one /gallery, showed. */
export type MediaSet = {
  /** The tool call's id, or `cmd-` and a hash of the command's arguments. */
  id: string
  title: string
  items: MediaItem[]
  /** Items found, which can be more than are kept. */
  total: number
  createdAt: number
}

export type GalleryMode = 'grid' | 'view'

export type FullscreenState = 'off' | 'starting' | 'on'

/** What the gallery pane shows. */
export type Gallery = {
  setId: string
  index: number
  mode: GalleryMode
  /** The large picture made for the item in view, and the path of that item. */
  picture: string
  pictureOf: string
  /** The file a video in view plays into, frame by frame; empty when it is not playing. */
  frames: string
  framesOf: string
  isPaused: boolean
  fullscreen: FullscreenState
}

declare module 'claude-code' {
  interface PluginState {
    'media-gallery': {
      sets: Shaped<Record<string, MediaSet>>
      gallery: Shaped<Gallery>
    }
  }
}
