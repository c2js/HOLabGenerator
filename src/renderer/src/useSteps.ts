import { useCallback, useEffect, useRef, useState } from 'react'
import type { LoadedProject, Step } from '@shared/types'
import { stepImages } from '@shared/types'

export interface StepActions {
  update: (id: string, patch: Partial<Step>) => void
  remove: (id: string) => void
  move: (id: string, delta: number) => void
  mergeUp: (id: string) => string | null
  split: (id: string, atChar: number) => string | null
  duplicate: (id: string) => void
  toggle: (id: string, field: 'quizWorthy' | 'sectionBreakBefore') => void
  setCallout: (id: string, callout: Step['callout']) => void
  setCaption: (stepId: string, imageId: string, caption: string | undefined) => void
  moveImage: (stepId: string, imageId: string, delta: number) => void
}

/**
 * Local step state with optimistic updates.
 *
 * Every mutation writes through to the main process, which renumbers image
 * tokens and persists. We keep a local copy so editing feels immediate and so a
 * save round trip never yanks the caret out of a textarea mid-word.
 */
export function useSteps(project: LoadedProject): {
  steps: Step[]
  actions: StepActions
} {
  const [steps, setSteps] = useState<Step[]>(project.steps)
  const dirty = useRef(false)

  useEffect(() => {
    // Adopt changes from the main process (new captures) unless the user is
    // mid-edit, in which case our local copy is the newer truth.
    if (!dirty.current) setSteps(project.steps)
  }, [project.steps])

  const commit = useCallback((next: Step[]) => {
    dirty.current = true
    setSteps(next)
    void window.api.project.saveSteps(next).finally(() => {
      dirty.current = false
    })
  }, [])

  const update = useCallback(
    (id: string, patch: Partial<Step>) => {
      commit(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)))
    },
    [commit, steps]
  )

  const remove = useCallback(
    (id: string) => commit(steps.filter((s) => s.id !== id)),
    [commit, steps]
  )

  const move = useCallback(
    (id: string, delta: number) => {
      const from = steps.findIndex((s) => s.id === id)
      const to = from + delta
      if (from === -1 || to < 0 || to >= steps.length) return
      const next = [...steps]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      commit(next)
    },
    [commit, steps]
  )

  /** Fold a step into the one above it. Returns an error message, or null on success. */
  const mergeUp = useCallback(
    (id: string): string | null => {
      const i = steps.findIndex((s) => s.id === id)
      if (i <= 0) return 'There is no step above this one.'

      const previous = steps[i - 1]
      const current = steps[i]

      const merged: Step = {
        ...previous,
        narration: [previous.narration, current.narration].map((t) => t.trim()).filter(Boolean).join(' '),
        // Both sets of screenshots survive, in order - merging no longer has to
        // discard one of them.
        images: [...stepImages(previous), ...stepImages(current)],
        code: previous.code ?? current.code,
        context: previous.context ?? current.context,
        callout: previous.callout ?? current.callout,
        quizWorthy: previous.quizWorthy || current.quizWorthy,
        title: previous.title || current.title
      }

      const next = [...steps]
      next.splice(i - 1, 2, merged)
      commit(next)
      return null
    },
    [commit, steps]
  )

  /**
   * Split a step at the caret.
   *
   * This is the fix for the most common capture mistake: talking through two
   * steps in one breath. Everything after the caret - plus the screenshot and
   * code, which belong to what was being described at the end - moves down.
   */
  const split = useCallback(
    (id: string, atChar: number): string | null => {
      const i = steps.findIndex((s) => s.id === id)
      if (i === -1) return 'Step not found.'

      const step = steps[i]
      const head = step.narration.slice(0, atChar).trim()
      const tail = step.narration.slice(atChar).trim()

      if (!head || !tail) return 'Put the cursor where the step should divide first.'

      const first: Step = { ...step, narration: head, images: undefined, code: undefined }
      const second: Step = {
        ...step,
        id: `${step.id}-split-${Date.now()}`,
        narration: tail,
        sectionBreakBefore: undefined,
        sectionTitle: undefined
      }

      const next = [...steps]
      next.splice(i, 1, first, second)
      commit(next)
      return null
    },
    [commit, steps]
  )

  const duplicate = useCallback(
    (id: string) => {
      const i = steps.findIndex((s) => s.id === id)
      if (i === -1) return
      const copy: Step = {
        ...steps[i],
        id: `${steps[i].id}-copy-${Date.now()}`,
        images: undefined
      }
      const next = [...steps]
      next.splice(i + 1, 0, copy)
      commit(next)
    },
    [commit, steps]
  )

  const toggle = useCallback(
    (id: string, field: 'quizWorthy' | 'sectionBreakBefore') => {
      commit(steps.map((s) => (s.id === id ? { ...s, [field]: !s[field] } : s)))
    },
    [commit, steps]
  )

  const setCallout = useCallback(
    (id: string, callout: Step['callout']) => {
      commit(steps.map((s) => (s.id === id ? { ...s, callout } : s)))
    },
    [commit, steps]
  )

  const setCaption = useCallback(
    (stepId: string, imageId: string, caption: string | undefined) => {
      commit(
        steps.map((s) =>
          s.id === stepId
            ? {
                ...s,
                images: stepImages(s).map((img) =>
                  img.id === imageId ? { ...img, caption } : img
                )
              }
            : s
        )
      )
    },
    [commit, steps]
  )

  const moveImage = useCallback(
    (stepId: string, imageId: string, delta: number) => {
      commit(
        steps.map((s) => {
          if (s.id !== stepId) return s
          const images = [...stepImages(s)]
          const from = images.findIndex((i) => i.id === imageId)
          const to = from + delta
          if (from === -1 || to < 0 || to >= images.length) return s
          const [item] = images.splice(from, 1)
          images.splice(to, 0, item)
          return { ...s, images }
        })
      )
    },
    [commit, steps]
  )

  return {
    steps,
    actions: {
      update,
      remove,
      move,
      mergeUp,
      split,
      duplicate,
      toggle,
      setCallout,
      setCaption,
      moveImage
    }
  }
}
