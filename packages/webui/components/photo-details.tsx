import { stackKey, type AssetInfo, type StackMember } from '@shumai/dtos'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Camera, Pencil } from 'lucide-react'
import { useState } from 'react'
import { client } from '@/ui/api/client'
import { usePermissions } from '@/ui/hooks/use-permissions'
import { cn } from '@/ui/lib/utils'
import { RecipeNameDialog, recipeParts, useFujiRecipeNames } from './photo/recipe-name'
import { m } from '@/ui/paraglide/messages.js'

interface PhotoDetailsProps {
  projectId: string
  file: AssetInfo
  /** Public share pages have no session for the stack lookup. */
  isPublic?: boolean
}

/** "DSCF5543.RAF.xmp" in the "dscf5543" stack -> "RAF.XMP"; "DSCF5543.JPG" -> "JPG". */
export function stackMemberLabel(name: string): string {
  const base = stackKey(name)
  const rest = name.slice(base.length).replace(/^\./, '')
  return (rest || name).toUpperCase()
}

function formatNumber(n: unknown, digits = 1): string | undefined {
  return typeof n === 'number' && Number.isFinite(n)
    ? String(Math.round(n * 10 ** digits) / 10 ** digits)
    : undefined
}

/**
 * The camera settings of a photo (from its EXIF system fields) and the other files of its shot,
 * shown above the comments and fields tabs.
 */
export function PhotoDetails({ projectId, file, isPublic }: PhotoDetailsProps) {
  const navigate = useNavigate()
  const values = new Map((file.fieldValues ?? []).map((v) => [v.fieldId, v.value]))

  const camera = values.get('camera') as string | undefined
  const lens = values.get('lens') as string | undefined
  const film = values.get('film_simulation') as string | undefined
  const recipe = values.get('fuji_recipe') as string | undefined
  const { canEdit } = usePermissions(projectId)
  const { names } = useFujiRecipeNames(projectId, !isPublic && !!recipe)
  const [naming, setNaming] = useState<string | null>(null)
  const recipeName = recipe ? names[recipe] : undefined
  const focal = formatNumber(values.get('focal_length'))
  const aperture = formatNumber(values.get('aperture'))
  const shutter = values.get('shutter_speed') as string | undefined
  const iso = formatNumber(values.get('iso'), 0)
  const takenRaw = values.get('capture_date')
  const taken = typeof takenRaw === 'string' || takenRaw instanceof Date ? new Date(takenRaw) : null

  const exposure = [
    focal && `${focal}mm`,
    aperture && `f/${aperture}`,
    shutter,
    iso && `ISO ${iso}`,
  ].filter(Boolean)

  const { data: members } = useQuery({
    queryKey: ['file-stack', file.id],
    enabled: !isPublic && !!file.id,
    queryFn: async (): Promise<StackMember[]> => {
      const res = await client.api.files[':fileId'].stack.$get({ param: { fileId: file.id } })
      if (!res.ok) throw new Error('failed to load the files of this shot')
      return (await res.json()).data
    },
  })
  const siblings = members && members.length > 1 ? members : null

  if (!camera && !lens && !film && !recipe && exposure.length === 0 && !taken && !siblings) {
    return null
  }

  return (
    <div className="shrink-0 space-y-2 border-b border-border/50 px-3 pb-3 pt-2 text-xs">
      {(camera || lens || film || exposure.length > 0 || taken) && (
        <div className="space-y-0.5" data-testid="photo-details-camera">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <Camera
              className="h-3.5 w-3.5 text-muted-foreground"
              aria-label={m.photo_info_title()}
            />
            <span className="truncate">{[camera, film].filter(Boolean).join(' · ')}</span>
          </div>
          {lens && <div className="truncate text-muted-foreground">{lens}</div>}
          {exposure.length > 0 && (
            <div className="tabular-nums text-muted-foreground">{exposure.join('  ')}</div>
          )}
          {taken && !isNaN(taken.getTime()) && (
            <div className="text-muted-foreground">
              {taken.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
            </div>
          )}
        </div>
      )}
      {recipe && (
        <div className="space-y-1" data-testid="photo-details-recipe">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {m.photo_filter_recipe()}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                recipeName ? 'font-medium text-foreground' : 'italic text-muted-foreground',
              )}
            >
              {recipeName ?? m.recipe_unnamed()}
            </span>
            {canEdit && !isPublic && (
              <button
                type="button"
                aria-label={m.recipe_name_title()}
                title={m.recipe_name_title()}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setNaming(recipe)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {recipeParts(recipe)
              .slice(1)
              .map((part) => (
                <span
                  key={part}
                  className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground"
                >
                  {part}
                </span>
              ))}
          </div>
          <RecipeNameDialog
            projectId={projectId}
            settings={naming}
            onClose={() => setNaming(null)}
          />
        </div>
      )}
      {siblings && (
        <div className="space-y-1" data-testid="photo-details-stack">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {m.stack_versions_label()}
          </div>
          <div className="flex flex-wrap gap-1">
            {siblings.map((member) => (
              <button
                key={member.id}
                type="button"
                title={member.name}
                onClick={() =>
                  member.id !== file.id &&
                  navigate({
                    to: '/projects/$projectId/files/$fileId',
                    params: { projectId, fileId: member.id },
                    search: { version: undefined },
                  })
                }
                className={cn(
                  'rounded border px-1.5 py-0.5 font-mono text-[11px]',
                  member.id === file.id
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:border-primary hover:text-foreground',
                )}
              >
                {stackMemberLabel(member.name)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
