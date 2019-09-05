import {
  isArray,
  isFunction,
  isString,
  isObject,
  EMPTY_ARR,
  extend
} from '@vue/shared'
import { ComponentInstance, Data, SetupProxySymbol } from './component'
import { HostNode } from './createRenderer'
import { RawSlots } from './componentSlots'
import { PatchFlags } from './patchFlags'
import { ShapeFlags } from './shapeFlags'
import { isReactive } from '@vue/reactivity'
import { AppContext } from './apiApp'

export const Fragment = Symbol('Fragment')
export const Text = Symbol('Text')
export const Empty = Symbol('Empty')
export const Portal = Symbol('Portal')

export type VNodeTypes =
  | string
  | Function
  | Object
  | typeof Fragment
  | typeof Portal
  | typeof Text
  | typeof Empty

type VNodeChildAtom = VNode | string | number | null | void
export interface VNodeChildren extends Array<VNodeChildren | VNodeChildAtom> {}
export type VNodeChild = VNodeChildAtom | VNodeChildren

export type NormalizedChildren = string | VNodeChildren | RawSlots | null

export interface VNode {
  type: VNodeTypes
  props: Record<any, any> | null
  key: string | number | null
  ref: string | Function | null
  children: NormalizedChildren
  component: ComponentInstance | null

  // DOM
  el: HostNode | null
  anchor: HostNode | null // fragment anchor
  target: HostNode | null // portal target

  // optimization only
  shapeFlag: number
  patchFlag: number
  dynamicProps: string[] | null
  dynamicChildren: VNode[] | null

  // application root node only
  appContext: AppContext | null
}

// Since v-if and v-for are the two possible ways node structure can dynamically
// change, once we consider v-if branches and each v-for fragment a block, we
// can divide a template into nested blocks, and within each block the node
// structure would be stable. This allows us to skip most children diffing
// and only worry about the dynamic nodes (indicated by patch flags).
const blockStack: (VNode[] | null)[] = []

// Open a block.
// This must be called before `createBlock`. It cannot be part of `createBlock`
// because the children of the block are evaluated before `createBlock` itself
// is called. The generated code typically looks like this:
//
//   function render() {
//     return (openBlock(),createBlock('div', null, [...]))
//   }
//
// disableTracking is true when creating a fragment block, since a fragment
// always diffs its children.
export function openBlock(disableTrackng?: boolean) {
  blockStack.push(disableTrackng ? null : [])
}

let shouldTrack = true

// Create a block root vnode. Takes the same exact arguments as `createVNode`.
// A block root keeps track of dynamic nodes within the block in the
// `dynamicChildren` array.
export function createBlock(
  type: VNodeTypes,
  props?: { [key: string]: any } | null,
  children?: any,
  patchFlag?: number,
  dynamicProps?: string[]
): VNode {
  // avoid a block with optFlag tracking itself
  shouldTrack = false
  const vnode = createVNode(type, props, children, patchFlag, dynamicProps)
  shouldTrack = true
  const trackedNodes = blockStack.pop()
  vnode.dynamicChildren =
    trackedNodes && trackedNodes.length ? trackedNodes : EMPTY_ARR
  // a block is always going to be patched
  trackDynamicNode(vnode)
  return vnode
}

export function createVNode(
  type: VNodeTypes,
  props: { [key: string]: any } | null | 0 = null,
  children: any = null,
  patchFlag: number = 0,
  dynamicProps: string[] | null = null
): VNode {
  // Allow passing 0 for props, this can save bytes on generated code.
  props = props || null

  // class & style normalization.
  if (props !== null) {
    // for reactive or proxy objects, we need to clone it to enable mutation.
    if (isReactive(props) || SetupProxySymbol in props) {
      props = extend({}, props)
    }
    // class normalization only needed if the vnode isn't generated by
    // compiler-optimized code
    if (props.class != null && !(patchFlag & PatchFlags.CLASS)) {
      props.class = normalizeClass(props.class)
    }
    let { style } = props
    if (style != null) {
      // reactive state objects need to be cloned since they are likely to be
      // mutated
      if (isReactive(style) && !isArray(style)) {
        style = extend({}, style)
      }
      props.style = normalizeStyle(style)
    }
  }

  // encode the vnode type information into a bitmap
  const shapeFlag = isString(type)
    ? ShapeFlags.ELEMENT
    : isObject(type)
      ? ShapeFlags.STATEFUL_COMPONENT
      : isFunction(type)
        ? ShapeFlags.FUNCTIONAL_COMPONENT
        : 0

  const vnode: VNode = {
    type,
    props,
    key: (props && props.key) || null,
    ref: (props && props.ref) || null,
    children: null,
    component: null,
    el: null,
    anchor: null,
    target: null,
    shapeFlag,
    patchFlag,
    dynamicProps,
    dynamicChildren: null,
    appContext: null
  }

  normalizeChildren(vnode, children)

  // presence of a patch flag indicates this node needs patching on updates.
  // component nodes also should always be patched, because even if the
  // component doesn't need to update, it needs to persist the instance on to
  // the next vnode so that it can be properly unmounted later.
  if (
    shouldTrack &&
    (patchFlag ||
      shapeFlag & ShapeFlags.STATEFUL_COMPONENT ||
      shapeFlag & ShapeFlags.FUNCTIONAL_COMPONENT)
  ) {
    trackDynamicNode(vnode)
  }

  return vnode
}

function trackDynamicNode(vnode: VNode) {
  const currentBlockDynamicNodes = blockStack[blockStack.length - 1]
  if (currentBlockDynamicNodes != null) {
    currentBlockDynamicNodes.push(vnode)
  }
}

export function cloneVNode(vnode: VNode): VNode {
  return {
    type: vnode.type,
    props: vnode.props,
    key: vnode.key,
    ref: vnode.ref,
    children: vnode.children,
    target: vnode.target,
    shapeFlag: vnode.shapeFlag,
    patchFlag: vnode.patchFlag,
    dynamicProps: vnode.dynamicProps,
    dynamicChildren: vnode.dynamicChildren,
    appContext: vnode.appContext,

    // these should be set to null since they should only be present on
    // mounted VNodes. If they are somehow not null, this means we have
    // encountered an already-mounted vnode being used again.
    component: null,
    el: null,
    anchor: null
  }
}

export function normalizeVNode(child: VNodeChild): VNode {
  if (child == null) {
    // empty placeholder
    return createVNode(Empty)
  } else if (isArray(child)) {
    // fragment
    return createVNode(Fragment, null, child)
  } else if (typeof child === 'object') {
    // already vnode, this should be the most common since compiled templates
    // always produce all-vnode children arrays
    return child.el === null ? child : cloneVNode(child)
  } else {
    // primitive types
    return createVNode(Text, null, child + '')
  }
}

export function normalizeChildren(vnode: VNode, children: unknown) {
  let type = 0
  if (children == null) {
    children = null
  } else if (isArray(children)) {
    type = ShapeFlags.ARRAY_CHILDREN
  } else if (typeof children === 'object') {
    type = ShapeFlags.SLOTS_CHILDREN
  } else if (isFunction(children)) {
    children = { default: children }
    type = ShapeFlags.SLOTS_CHILDREN
  } else {
    children = isString(children) ? children : children + ''
    type = ShapeFlags.TEXT_CHILDREN
  }
  vnode.children = children as NormalizedChildren
  vnode.shapeFlag |= type
}

function normalizeStyle(
  value: unknown
): Record<string, string | number> | void {
  if (isArray(value)) {
    const res: Record<string, string | number> = {}
    for (let i = 0; i < value.length; i++) {
      const normalized = normalizeStyle(value[i])
      if (normalized) {
        for (const key in normalized) {
          res[key] = normalized[key]
        }
      }
    }
    return res
  } else if (isObject(value)) {
    return value
  }
}

export function normalizeClass(value: unknown): string {
  let res = ''
  if (isString(value)) {
    res = value
  } else if (isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      res += normalizeClass(value[i]) + ' '
    }
  } else if (isObject(value)) {
    for (const name in value) {
      if (value[name]) {
        res += name + ' '
      }
    }
  }
  return res.trim()
}

const handlersRE = /^on|^vnode/

export function mergeProps(...args: Data[]) {
  const ret: Data = {}
  extend(ret, args[0])
  for (let i = 1; i < args.length; i++) {
    const toMerge = args[i]
    for (const key in toMerge) {
      if (key === 'class') {
        ret.class = normalizeClass([ret.class, toMerge.class])
      } else if (key === 'style') {
        ret.style = normalizeStyle([ret.style, toMerge.style])
      } else if (handlersRE.test(key)) {
        // on*, vnode*
        const existing = ret[key]
        ret[key] = existing
          ? [].concat(existing as any, toMerge[key] as any)
          : toMerge[key]
      } else {
        ret[key] = toMerge[key]
      }
    }
  }
  return ret
}
