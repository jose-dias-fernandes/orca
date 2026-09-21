import type { TaskPageJiraCreationMetadataModel } from './use-task-page-jira-creation-metadata'
import { useState, useEffect } from 'react'
import type { BusinessmapBoard } from '../../../shared/businessmap-types'

export function useTaskPageBusinessmapCreationState(model: TaskPageJiraCreationMetadataModel) {
  const { providerRuntimeContextKey, businessmapConnected } = model
  const [newBusinessmapCardOpen, setNewBusinessmapCardOpen] = useState(false)
  const [newBusinessmapCardTitle, setNewBusinessmapCardTitle] = useState('')
  const [newBusinessmapCardBody, setNewBusinessmapCardBody] = useState('')
  const [newBusinessmapCardBoardId, setNewBusinessmapCardBoardId] = useState<number | null>(null)
  const [newBusinessmapCardSubmitting, setNewBusinessmapCardSubmitting] = useState(false)
  const [availableBusinessmapBoards, setAvailableBusinessmapBoards] = useState<BusinessmapBoard[]>(
    []
  )
  const [businessmapBoardsLoading, setBusinessmapBoardsLoading] = useState(false)
  useEffect(() => {
    if (!newBusinessmapCardOpen || !businessmapConnected || newBusinessmapCardBoardId !== null) {
      return
    }
    setNewBusinessmapCardBoardId(availableBusinessmapBoards[0]?.id ?? null)
  }, [
    newBusinessmapCardOpen,
    businessmapConnected,
    newBusinessmapCardBoardId,
    availableBusinessmapBoards
  ])
  // Why: provider changes must clear dependent composer state before stale values can be submitted.
  useEffect(() => {
    setNewBusinessmapCardOpen(false)
    setNewBusinessmapCardTitle('')
    setNewBusinessmapCardBody('')
    setNewBusinessmapCardBoardId(null)
    setNewBusinessmapCardSubmitting(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerRuntimeContextKey])
  const discardNewBusinessmapCardDraft = (): void => {
    setNewBusinessmapCardTitle('')
    setNewBusinessmapCardBody('')
  }
  const nextModel = model as typeof model & {
    newBusinessmapCardOpen: typeof newBusinessmapCardOpen
    setNewBusinessmapCardOpen: typeof setNewBusinessmapCardOpen
    newBusinessmapCardTitle: typeof newBusinessmapCardTitle
    setNewBusinessmapCardTitle: typeof setNewBusinessmapCardTitle
    newBusinessmapCardBody: typeof newBusinessmapCardBody
    setNewBusinessmapCardBody: typeof setNewBusinessmapCardBody
    newBusinessmapCardBoardId: typeof newBusinessmapCardBoardId
    setNewBusinessmapCardBoardId: typeof setNewBusinessmapCardBoardId
    newBusinessmapCardSubmitting: typeof newBusinessmapCardSubmitting
    setNewBusinessmapCardSubmitting: typeof setNewBusinessmapCardSubmitting
    availableBusinessmapBoards: typeof availableBusinessmapBoards
    setAvailableBusinessmapBoards: typeof setAvailableBusinessmapBoards
    businessmapBoardsLoading: typeof businessmapBoardsLoading
    setBusinessmapBoardsLoading: typeof setBusinessmapBoardsLoading
    discardNewBusinessmapCardDraft: typeof discardNewBusinessmapCardDraft
  }
  nextModel.newBusinessmapCardOpen = newBusinessmapCardOpen
  nextModel.setNewBusinessmapCardOpen = setNewBusinessmapCardOpen
  nextModel.newBusinessmapCardTitle = newBusinessmapCardTitle
  nextModel.setNewBusinessmapCardTitle = setNewBusinessmapCardTitle
  nextModel.newBusinessmapCardBody = newBusinessmapCardBody
  nextModel.setNewBusinessmapCardBody = setNewBusinessmapCardBody
  nextModel.newBusinessmapCardBoardId = newBusinessmapCardBoardId
  nextModel.setNewBusinessmapCardBoardId = setNewBusinessmapCardBoardId
  nextModel.newBusinessmapCardSubmitting = newBusinessmapCardSubmitting
  nextModel.setNewBusinessmapCardSubmitting = setNewBusinessmapCardSubmitting
  nextModel.availableBusinessmapBoards = availableBusinessmapBoards
  nextModel.setAvailableBusinessmapBoards = setAvailableBusinessmapBoards
  nextModel.businessmapBoardsLoading = businessmapBoardsLoading
  nextModel.setBusinessmapBoardsLoading = setBusinessmapBoardsLoading
  nextModel.discardNewBusinessmapCardDraft = discardNewBusinessmapCardDraft
  return nextModel
}

export type TaskPageBusinessmapCreationStateModel = ReturnType<
  typeof useTaskPageBusinessmapCreationState
>
