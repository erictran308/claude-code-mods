import type { ClientModule } from 'claude-code'

export type HitAction = 'toggle' | 'mention' | 'show'
export type HitProps = { action: HitAction; path: string }

// An invisible click area over a row. The engine inverts a Button under the
// pointer whatever it holds, which would paint over the row's own colors.
const Hit: ClientModule<HitProps> = (props, surface) => {
  const { Box } = surface.elements
  surface.onPointer(e => {
    if (e.type === 'down' && (e.button ?? 'left') === 'left') surface.post({ action: props.action, path: props.path })
  })
  return <Box width="100%" height="100%" />
}

export default Hit
