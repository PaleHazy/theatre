import get from 'lodash-es/get'
import React from 'react'
import type {Pointer} from '@theatre/dataverse'
import {getPointerParts, prism, val} from '@theatre/dataverse'
import type SheetObject from '@theatre/core/sheetObjects/SheetObject'
import getStudio from '@theatre/studio/getStudio'
import type Scrub from '@theatre/studio/Scrub'
import type {IContextMenuItem} from '@theatre/studio/uiComponents/simpleContextMenu/useContextMenu'
import getDeep from '@theatre/shared/utils/getDeep'
import {usePrism} from '@theatre/react'
import type {SerializablePrimitive as SerializablePrimitive} from '@theatre/shared/utils/types'
import type {PropTypeConfig_AllSimples} from '@theatre/core/propTypes'
import {isPropConfSequencable} from '@theatre/shared/propTypes/utils'
import type {SequenceTrackId} from '@theatre/shared/utils/ids'
import DefaultOrStaticValueIndicator from './DefaultValueIndicator'
import type {NearbyKeyframes} from './getNearbyKeyframesOfTrack'
import {getNearbyKeyframesOfTrack} from './getNearbyKeyframesOfTrack'
import type {NearbyKeyframesControls} from './NextPrevKeyframeCursors'
import NextPrevKeyframeCursors from './NextPrevKeyframeCursors'

interface EditingToolsCommon<T> {
  value: T
  beingScrubbed: boolean
  contextMenuItems: Array<IContextMenuItem>
  /** e.g. `< • >` or `<   >` for {@link EditingToolsSequenced} */
  controlIndicators: React.ReactElement

  temporarilySetValue(v: T): void
  discardTemporaryValue(): void
  permanentlySetValue(v: T): void
}

interface EditingToolsDefault<T> extends EditingToolsCommon<T> {
  type: 'Default'
  shade: Shade
}

interface EditingToolsStatic<T> extends EditingToolsCommon<T> {
  type: 'Static'
  shade: Shade
}

interface EditingToolsSequenced<T> extends EditingToolsCommon<T> {
  type: 'Sequenced'
  shade: Shade
  /** based on the position of the playhead */
  nearbyKeyframes: NearbyKeyframes
}

type EditingTools<T> =
  | EditingToolsDefault<T>
  | EditingToolsStatic<T>
  | EditingToolsSequenced<T>

/**
 * Notably, this uses the {@link Scrub} API to support
 * indicating in the UI which pointers (values/props) are being
 * scrubbed. See how impl of {@link Scrub} manages
 * `state.flagsTransaction` to keep a list of these touched paths
 * for the UI to be able to recognize. (e.g. to highlight the
 * item in r3f as you change its scale).
 */
export function useEditingToolsForSimplePropInDetailsPanel<
  T extends SerializablePrimitive,
>(
  pointerToProp: Pointer<T>,
  obj: SheetObject,
  propConfig: PropTypeConfig_AllSimples,
): EditingTools<T> {
  return usePrism(() => {
    const pathToProp = getPointerParts(pointerToProp).path

    const final = obj.getValueByPointer(pointerToProp) as T

    const editPropValue = prism.memo(
      'editPropValue',
      () => {
        let currentScrub: Scrub | null = null

        return {
          temporarilySetValue(v: T): void {
            if (!currentScrub) {
              currentScrub = getStudio()!.scrub()
            }
            currentScrub.capture((api) => {
              api.set(pointerToProp, v)
            })
          },
          discardTemporaryValue(): void {
            if (currentScrub) {
              currentScrub.discard()
              currentScrub = null
            }
          },
          permanentlySetValue(v: T): void {
            if (currentScrub) {
              currentScrub.capture((api) => {
                api.set(pointerToProp, v)
              })
              currentScrub.commit()
              currentScrub = null
            } else {
              getStudio()!.transaction((api) => {
                api.set(pointerToProp, v)
              })
            }
          },
        }
      },
      [],
    )

    const beingScrubbed =
      val(
        get(
          getStudio()!.atomP.ephemeral.projects.stateByProjectId[
            obj.address.projectId
          ].stateBySheetId[obj.address.sheetId].stateByObjectKey[
            obj.address.objectKey
          ].valuesBeingScrubbed,
          getPointerParts(pointerToProp).path,
        ),
      ) === true

    const contextMenuItems: IContextMenuItem[] = []

    const common: EditingToolsCommon<T> = {
      ...editPropValue,
      value: final,
      beingScrubbed,
      contextMenuItems,
      controlIndicators: <></>,
    }

    const isSequencable = isPropConfSequencable(propConfig)

    if (isSequencable) {
      const validSequencedTracks = val(
        obj.template.getMapOfValidSequenceTracks_forStudio(),
      )
      const possibleSequenceTrackId = getDeep(validSequencedTracks, pathToProp)

      const isSequenced = typeof possibleSequenceTrackId === 'string'

      if (isSequenced) {
        contextMenuItems.push({
          label: 'Make static',
          callback: () => {
            getStudio()!.transaction(({stateEditors}) => {
              const propAddress = {...obj.address, pathToProp}
              stateEditors.coreByProject.historic.sheetsById.sequence.setPrimitivePropAsStatic(
                {
                  ...propAddress,
                  value: obj.getValueByPointer(pointerToProp) as T,
                },
              )
            })
          },
        })

        const sequenceTrackId = possibleSequenceTrackId as SequenceTrackId
        const nearbyKeyframes = prism.sub(
          'lcr',
          (): NearbyKeyframes => {
            const track = val(
              obj.template.project.pointers.historic.sheetsById[
                obj.address.sheetId
              ].sequence.tracksByObject[obj.address.objectKey].trackData[
                sequenceTrackId
              ],
            )
            const sequencePosition = val(
              obj.sheet.getSequence().positionDerivation,
            )
            return getNearbyKeyframesOfTrack(track, sequencePosition)
          },
          [sequenceTrackId],
        )

        let shade: Shade

        if (common.beingScrubbed) {
          shade = 'Sequenced_OnKeyframe_BeingScrubbed'
        } else {
          if (nearbyKeyframes.cur) {
            shade = 'Sequenced_OnKeyframe'
          } else if (nearbyKeyframes.prev?.connectedRight === true) {
            shade = 'Sequenced_BeingInterpolated'
          } else {
            shade = 'Sequened_NotBeingInterpolated'
          }
        }

        const controls: NearbyKeyframesControls = {
          cur: {
            type: nearbyKeyframes.cur ? 'on' : 'off',
            toggle: () => {
              if (nearbyKeyframes.cur) {
                getStudio()!.transaction((api) => {
                  api.unset(pointerToProp)
                })
              } else {
                getStudio()!.transaction((api) => {
                  api.set(pointerToProp, common.value)
                })
              }
            },
          },
          prev:
            nearbyKeyframes.prev !== undefined
              ? {
                  position: nearbyKeyframes.prev.position,
                  jump: () => {
                    obj.sheet.getSequence().position =
                      nearbyKeyframes.prev!.position
                  },
                }
              : undefined,
          next:
            nearbyKeyframes.next !== undefined
              ? {
                  position: nearbyKeyframes.next.position,
                  jump: () => {
                    obj.sheet.getSequence().position =
                      nearbyKeyframes.next!.position
                  },
                }
              : undefined,
        }

        const nextPrevKeyframeCursors = (
          <NextPrevKeyframeCursors {...controls} />
        )

        const ret: EditingToolsSequenced<T> = {
          ...common,
          type: 'Sequenced',
          shade,
          nearbyKeyframes,
          controlIndicators: nextPrevKeyframeCursors,
        }

        return ret
      }
    }

    contextMenuItems.push({
      label: 'Reset to default',
      callback: () => {
        getStudio()!.transaction(({unset: unset}) => {
          unset(pointerToProp)
        })
      },
    })

    if (isSequencable) {
      contextMenuItems.push({
        label: 'Sequence',
        callback: () => {
          getStudio()!.transaction(({stateEditors}) => {
            const propAddress = {...obj.address, pathToProp}

            stateEditors.coreByProject.historic.sheetsById.sequence.setPrimitivePropAsSequenced(
              propAddress,
              propConfig,
            )
          })
        },
      })
    }

    const statics = val(obj.template.getStaticValues())

    if (typeof getDeep(statics, pathToProp) !== 'undefined') {
      const ret: EditingToolsStatic<T> = {
        ...common,
        type: 'Static',
        shade: common.beingScrubbed ? 'Static_BeingScrubbed' : 'Static',
        controlIndicators: (
          <DefaultOrStaticValueIndicator hasStaticOverride={true} />
        ),
      }
      return ret
    }

    const ret: EditingToolsDefault<T> = {
      ...common,
      type: 'Default',
      shade: 'Default',
      controlIndicators: (
        <DefaultOrStaticValueIndicator hasStaticOverride={false} />
      ),
    }

    return ret
  }, [])
}

type Shade =
  | 'Default'
  | 'Static'
  | 'Static_BeingScrubbed'
  | 'Sequenced_OnKeyframe'
  | 'Sequenced_OnKeyframe_BeingScrubbed'
  | 'Sequenced_BeingInterpolated'
  | 'Sequened_NotBeingInterpolated'
