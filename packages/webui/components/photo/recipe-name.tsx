import { suggestRecipeNames, type FujiRecipeNames } from '@shumai/dtos'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { client } from '@/ui/api/client'
import { Button } from '@/ui/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/components/ui/dialog'
import { Input } from '@/ui/components/ui/input'
import { m } from '@/ui/paraglide/messages.js'

/** The team's recipe names (settings line -> name), and a setter. */
export function useFujiRecipeNames(projectId: string, enabled = true) {
  const queryClient = useQueryClient()
  const queryKey = ['fuji-recipe-names', projectId]
  const { data: names = {} } = useQuery({
    queryKey,
    enabled: enabled && !!projectId,
    queryFn: async (): Promise<FujiRecipeNames> => {
      const res = await client.api.projects[':projectId']['fuji-recipe-names'].$get({
        param: { projectId },
      })
      if (!res.ok) throw new Error('failed to load recipe names')
      return (await res.json()).data
    },
  })
  const { mutateAsync: setName, isPending } = useMutation({
    mutationFn: async ({ settings, name }: { settings: string; name: string }) => {
      const res = await client.api.projects[':projectId']['fuji-recipe-names'].$put({
        param: { projectId },
        json: { settings, name },
      })
      if (!res.ok) throw new Error('failed to save the recipe name')
      return (await res.json()).data
    },
    onSuccess: (next) => queryClient.setQueryData(queryKey, next),
  })
  return { names, setName, isPending }
}

/** "Classic Neg. | Grain Off | ..." -> ["Classic Neg.", "Grain Off", ...] */
export const recipeParts = (settings: string) => settings.split(' | ')

interface RecipeNameDialogProps {
  projectId: string
  /** The recipe's settings line being named; null closes the dialog. */
  settings: string | null
  onClose: () => void
}

/**
 * Name a Fujifilm recipe once for the whole team. Offers the name of a recipe that differs only in
 * clarity, as it is and with this recipe's clarity noted ("Reggie's Portra (Clarity 0)").
 */
export function RecipeNameDialog({ projectId, settings, onClose }: RecipeNameDialogProps) {
  const { names, setName, isPending } = useFujiRecipeNames(projectId, settings !== null)
  const [value, setValue] = useState('')
  useEffect(() => {
    if (settings !== null) setValue(names[settings] ?? '')
  }, [settings, names])

  const suggestions = settings ? suggestRecipeNames(settings, names) : []
  const save = async (name: string) => {
    if (!settings) return
    await setName({ settings, name: name.trim() })
    onClose()
  }

  return (
    <Dialog open={settings !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{m.recipe_name_title()}</DialogTitle>
          <DialogDescription>{m.recipe_name_hint()}</DialogDescription>
        </DialogHeader>
        {settings && (
          <div className="flex flex-wrap gap-1" data-testid="recipe-settings">
            {recipeParts(settings).map((part) => (
              <span key={part} className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
                {part}
              </span>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save(value)
          }}
          className="space-y-2"
        >
          <Input
            autoFocus
            value={value}
            maxLength={100}
            placeholder={m.recipe_name_placeholder()}
            onChange={(e) => setValue(e.target.value)}
          />
          {suggestions.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">{m.recipe_name_suggestions()}</div>
              <div className="flex flex-wrap gap-1">
                {suggestions.map((s) => (
                  <Button
                    key={s}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setValue(s)}
                  >
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            {settings && names[settings] ? (
              <Button type="button" variant="ghost" disabled={isPending} onClick={() => save('')}>
                {m.recipe_name_remove()}
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={isPending || !value.trim()}>
              {m.save()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
