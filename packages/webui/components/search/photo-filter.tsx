import {
  isPhotoFilterActive,
  type FujiRecipeNames,
  type PhotoFacet,
  type PhotoFacetValue,
  type PhotoFacets,
  type PhotoFilter as PhotoFilterValue,
  type SearchCondition,
} from '@shumai/dtos'
import { useQuery } from '@tanstack/react-query'
import { Camera, Layers, Pencil } from 'lucide-react'
import { useMemo, useState } from 'react'
import { client } from '@/ui/api/client'
import { Badge } from '@/ui/components/ui/badge'
import { Button } from '@/ui/components/ui/button'
import { Checkbox } from '@/ui/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/components/ui/popover'
import { Separator } from '@/ui/components/ui/separator'
import { cn } from '@/ui/lib/utils'
import { usePermissions } from '@/ui/hooks/use-permissions'
import { RecipeNameDialog, useFujiRecipeNames } from '@/ui/components/photo/recipe-name'
import { m } from '@/ui/paraglide/messages.js'
import { useUserMetadataStore } from '@/ui/stores/user-metadata'

/** Where the camera filter is remembered: per user, per project, like the sort order. */
export const photoFilterMetadataKey = (projectId: string) => `project:${projectId}:photoFilter`

/** Whether files sharing a base name show as one stacked card, per user, per project. */
export const stackMetadataKey = (projectId: string) => `project:${projectId}:stack`

const SECTIONS: Array<{ facet: PhotoFacet; label: () => string }> = [
  { facet: 'camera', label: m.photo_filter_camera },
  { facet: 'lens', label: m.photo_filter_lens },
  { facet: 'filmSimulation', label: m.photo_filter_film_simulation },
]

interface RecipeRow {
  /** The team's name for these settings, or null when not named yet. */
  name: string | null
  /** Settings lines in this row (a name can cover several, e.g. with and without clarity). */
  settings: string[]
  count: number
}

/** Named recipes merged by name (most shots first), then each unnamed recipe on its own. */
export function groupRecipes(values: PhotoFacetValue[], names: FujiRecipeNames): RecipeRow[] {
  const named = new Map<string, RecipeRow>()
  const unnamed: RecipeRow[] = []
  for (const { value, count } of values) {
    const name = names[value]
    if (!name) {
      unnamed.push({ name: null, settings: [value], count })
      continue
    }
    const row = named.get(name) ?? { name, settings: [], count: 0 }
    row.settings.push(value)
    row.count += count
    named.set(name, row)
  }
  return [...[...named.values()].sort((a, b) => b.count - a.count), ...unnamed]
}

interface PhotoFilterProps {
  teamId: string
  projectId: string
  folderId: string
  /** The conditions of the search or collection being viewed; choices are counted within them. */
  conditions?: SearchCondition[]
  disabled?: boolean
}

export function PhotoFilter({
  teamId,
  projectId,
  folderId,
  conditions = [],
  disabled,
}: PhotoFilterProps) {
  const { metadata, setMetadata } = useUserMetadataStore()
  const [open, setOpen] = useState(false)
  const key = photoFilterMetadataKey(projectId)
  const value = (metadata[key] as PhotoFilterValue | undefined) ?? {}
  const { canEdit } = usePermissions(projectId)
  const { names } = useFujiRecipeNames(projectId, open)
  const [naming, setNaming] = useState<string | null>(null)

  const { data: facets, isLoading } = useQuery({
    queryKey: ['photo-facets', folderId, conditions],
    enabled: open && !!folderId,
    queryFn: async (): Promise<PhotoFacets> => {
      // Subfolders count too: picking a value lists matching photos from them (see
      // FileSystemManager), so the choices match what the listing will show.
      const res = await client.api.folders[':folderId']['photo-facets'].$post({
        param: { folderId },
        json: { recursively: true, operator: 'AND', conditions },
      })
      if (!res.ok) throw new Error('failed to load camera details')
      return (await res.json()).data
    },
  })

  const save = (next: PhotoFilterValue) => setMetadata(teamId, key, next)
  const toggle = (facet: PhotoFacet, v: string) => {
    const list = value[facet] ?? []
    save({ ...value, [facet]: list.includes(v) ? list.filter((x) => x !== v) : [...list, v] })
  }
  const recipes = useMemo(() => groupRecipes(facets?.fujiRecipe ?? [], names), [facets, names])
  const chosenRecipes = value.fujiRecipe ?? []
  const toggleRecipe = (row: RecipeRow) => {
    const on = row.settings.every((x) => chosenRecipes.includes(x))
    save({
      ...value,
      fujiRecipe: on
        ? chosenRecipes.filter((x) => !row.settings.includes(x))
        : [...new Set([...chosenRecipes, ...row.settings])],
    })
  }
  // A named recipe counts once in the badge, however many settings lines it covers.
  const activeCount =
    SECTIONS.reduce((n, s) => n + (value[s.facet]?.length ?? 0), 0) +
    new Set(chosenRecipes.map((x) => names[x] ?? x)).size
  const empty =
    !!facets && SECTIONS.every((s) => facets[s.facet].length === 0) && recipes.length === 0

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            'gap-1.5 text-muted-foreground',
            isPhotoFilterActive(value) && 'text-foreground',
          )}
          aria-label={m.photo_filter_title()}
        >
          <Camera className="h-4 w-4" />
          <span>{m.photo_filter()}</span>
          {activeCount > 0 && (
            <Badge variant="secondary" className="h-5 px-1.5 text-[11px]">
              {activeCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        {isLoading && <p className="p-3 text-sm text-muted-foreground">{m.loading()}</p>}
        {empty && <p className="p-3 text-sm text-muted-foreground">{m.photo_filter_empty()}</p>}
        {facets && !empty && (
          <p className="px-3 pt-3 text-xs text-muted-foreground">{m.photo_filter_scope()}</p>
        )}
        {facets &&
          SECTIONS.filter((s) => facets[s.facet].length > 0).map((s, i) => (
            <div key={s.facet}>
              {i > 0 && <Separator />}
              <div className="p-3 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {s.label()}
              </div>
              <div className="max-h-48 space-y-1 overflow-y-auto px-3 pb-3">
                {facets[s.facet].map(({ value: v, count }) => (
                  <label key={v} className="flex cursor-pointer items-center gap-2 py-1 text-sm">
                    <Checkbox
                      checked={value[s.facet]?.includes(v) ?? false}
                      onCheckedChange={() => toggle(s.facet, v)}
                    />
                    <span className="flex-1 truncate" title={v}>
                      {v}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        {recipes.length > 0 && (
          <div data-testid="photo-filter-recipes">
            <Separator />
            <div className="p-3 pb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {m.photo_filter_recipe()}
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto px-3 pb-3">
              {recipes.map((row) => (
                <div key={row.settings[0]} className="flex items-center gap-2 py-1 text-sm">
                  <Checkbox
                    checked={row.settings.every((x) => chosenRecipes.includes(x))}
                    onCheckedChange={() => toggleRecipe(row)}
                  />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    title={row.settings.join('\n')}
                    onClick={() => toggleRecipe(row)}
                  >
                    {row.name ? (
                      <span className="block truncate">{row.name}</span>
                    ) : (
                      <>
                        <span className="block truncate italic text-muted-foreground">
                          {m.recipe_unnamed()}
                        </span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {row.settings[0]}
                        </span>
                      </>
                    )}
                  </button>
                  <span className="text-xs tabular-nums text-muted-foreground">{row.count}</span>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      aria-label={m.recipe_name_title()}
                      onClick={() => setNaming(row.settings[0])}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
        {activeCount > 0 && (
          <>
            <Separator />
            <div className="flex justify-end p-2">
              <Button variant="ghost" size="sm" onClick={() => save({})}>
                {m.file_type_clear()}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
      <RecipeNameDialog projectId={projectId} settings={naming} onClose={() => setNaming(null)} />
    </Popover>
  )
}

interface StackToggleProps {
  teamId: string
  projectId: string
  disabled?: boolean
}

/** Show each shot (DSCF5543.JPG, .RAF, .RAF.xmp) as one card, or every file on its own. */
export function StackToggle({ teamId, projectId, disabled }: StackToggleProps) {
  const { metadata, setMetadata } = useUserMetadataStore()
  const key = stackMetadataKey(projectId)
  const on = metadata[key] === true
  return (
    <Button
      variant={on ? 'secondary' : 'ghost'}
      size="sm"
      disabled={disabled}
      aria-pressed={on}
      title={on ? m.stack_toggle_on_hint() : m.stack_toggle_off_hint()}
      className={cn('gap-1.5', !on && 'text-muted-foreground')}
      onClick={() => setMetadata(teamId, key, !on)}
    >
      <Layers className="h-4 w-4" />
      <span>{m.stack_toggle()}</span>
    </Button>
  )
}
