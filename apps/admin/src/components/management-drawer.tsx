import { useLayoutEffect, useRef, type ComponentProps } from 'react'
import { Drawer } from '@arco-design/web-react'

export function ManagementDrawer(props: ComponentProps<typeof Drawer>) {
  const restoreFrame = useRef(0)
  useLayoutEffect(() => {
    if (!props.visible) return
    cancelAnimationFrame(restoreFrame.current)
    const trigger = document.activeElement
    return () => {
      // Wait for the drawer's focus lock to release the document.
      restoreFrame.current = requestAnimationFrame(() => {
        if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true })
      })
    }
  }, [props.visible])
  return <Drawer {...props} focusLock={props.visible ? props.focusLock : false} />
}
