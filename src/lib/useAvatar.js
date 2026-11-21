import { useCallback, useEffect, useState } from 'react'
import { useAuth } from './auth'
import {
  AVATAR_BUCKET,
  avatarErrorMessage,
  avatarExtensionFromMime,
  avatarStoragePath,
  compressAvatarImage,
  readAvatarPath,
  readAvatarUrl,
  validateAvatarFile,
} from './avatar'

// État partagé de la photo de profil.
//
// Source de vérité : `user.user_metadata.avatar_url` (Supabase Auth), donc la
// photo revient automatiquement après connexion, rafraîchissement ou nouvel
// onglet. Un petit magasin en mémoire diffuse les changements immédiats à la
// Topbar, la Sidebar et la page Profil sans attendre le retour réseau.
// En mode démonstration local (aucun backend), la photo est stockée dans
// localStorage pour que l'interface reste réellement utilisable.

const DEMO_PREFIX = 'veyvro.demo.avatar.'
const urlCache = new Map()
const listeners = new Set()

function emit(userId, url) {
  if (userId) {
    if (url) urlCache.set(userId, url)
    else urlCache.delete(userId)
  }
  for (const listener of listeners) listener(userId, url ?? null)
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function readDemoAvatar(userId) {
  if (!userId) return null
  try {
    return localStorage.getItem(DEMO_PREFIX + userId) || null
  } catch {
    return null
  }
}

function writeDemoAvatar(userId, dataUrl) {
  if (!userId) return
  try {
    if (dataUrl) localStorage.setItem(DEMO_PREFIX + userId, dataUrl)
    else localStorage.removeItem(DEMO_PREFIX + userId)
  } catch {
    /* stockage local indisponible : l'aperçu reste en mémoire */
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(new Error("Cette image n'a pas pu être lue."))
    reader.readAsDataURL(blob)
  })
}

function publicUrlWithVersion(publicUrl, version) {
  if (!publicUrl) return ''
  return `${publicUrl}${publicUrl.includes('?') ? '&' : '?'}v=${version}`
}

export function useAvatar() {
  const { user, isDemo, getSupabase: getClient } = useAuth()
  const userId = user?.id ?? null
  const [avatarUrl, setAvatarUrl] = useState(() =>
    isDemo ? readDemoAvatar(userId) : readAvatarUrl(user)
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Les métadonnées du compte sont la source de vérité : toute mise à jour de
  // session (connexion, rafraîchissement, updateUser) recharge la photo.
  useEffect(() => {
    const fromAccount = isDemo ? readDemoAvatar(userId) : readAvatarUrl(user)
    const cached = userId ? urlCache.get(userId) : null
    setAvatarUrl(fromAccount || cached || null)
  }, [user, isDemo, userId])

  // Les autres vues déjà montées reçoivent le changement immédiatement.
  useEffect(
    () =>
      subscribe((changedUserId, url) => {
        if (changedUserId === userId) setAvatarUrl(url)
      }),
    [userId]
  )

  const saveAvatar = useCallback(
    async (file) => {
      if (!userId) {
        const message = 'Connectez-vous pour ajouter une photo de profil.'
        setError(message)
        return { ok: false, message }
      }
      const invalid = validateAvatarFile(file)
      if (invalid) {
        setError(invalid)
        return { ok: false, message: invalid }
      }
      setBusy(true)
      setError(null)
      try {
        const blob = await compressAvatarImage(file)

        if (isDemo) {
          const dataUrl = await blobToDataUrl(blob)
          if (!dataUrl.startsWith('data:image/')) {
            throw new Error("Cette image n'a pas pu être lue.")
          }
          writeDemoAvatar(userId, dataUrl)
          emit(userId, dataUrl)
          return { ok: true, url: dataUrl }
        }

        const client = await getClient()
        const bucket = client.storage.from(AVATAR_BUCKET)
        const path = avatarStoragePath(userId, avatarExtensionFromMime(blob.type))
        const { error: uploadError } = await bucket.upload(path, blob, {
          upsert: true,
          cacheControl: '3600',
          contentType: blob.type || 'image/webp',
        })
        if (uploadError) throw uploadError

        const { data: publicData } = bucket.getPublicUrl(path)
        const publicUrl = publicData?.publicUrl
        if (!publicUrl) throw new Error("L'URL publique de la photo n'a pas pu être obtenue.")
        // Le nom du fichier reste stable pour n'avoir qu'une photo par compte :
        // le paramètre de version casse le cache du navigateur et du CDN.
        const url = publicUrlWithVersion(publicUrl, Date.now())
        const previousPath = readAvatarPath(user)

        const { error: metadataError } = await client.auth.updateUser({
          data: {
            avatar_url: url,
            avatar_path: path,
            avatar_updated_at: new Date().toISOString(),
          },
        })
        if (metadataError) throw metadataError

        // Ancien fichier d'une autre extension : nettoyage sans bloquer le
        // succès, la photo est déjà enregistrée et affichée.
        if (previousPath && previousPath !== path) {
          try {
            await bucket.remove([previousPath])
          } catch {
            /* nettoyage best-effort */
          }
        }

        emit(userId, url)
        return { ok: true, url }
      } catch (err) {
        const message = avatarErrorMessage(err)
        setError(message)
        return { ok: false, message }
      } finally {
        setBusy(false)
      }
    },
    [userId, isDemo, getClient, user]
  )

  const removeAvatar = useCallback(async () => {
    if (!userId) {
      const message = 'Connectez-vous pour gérer votre photo de profil.'
      setError(message)
      return { ok: false, message }
    }
    setBusy(true)
    setError(null)
    try {
      if (isDemo) {
        writeDemoAvatar(userId, null)
        emit(userId, null)
        return { ok: true }
      }

      const client = await getClient()
      const bucket = client.storage.from(AVATAR_BUCKET)
      const paths = new Set()
      const current = readAvatarPath(user)
      if (current) paths.add(current)
      // Toutes les extensions possibles du dossier de l'utilisateur, pour ne
      // jamais laisser un fichier orphelin après un changement de format.
      for (const extension of ['webp', 'png', 'jpg']) paths.add(avatarStoragePath(userId, extension))
      try {
        await bucket.remove([...paths])
      } catch {
        /* un fichier déjà absent ne doit pas empêcher la suppression */
      }

      const { error: metadataError } = await client.auth.updateUser({
        data: {
          avatar_url: null,
          avatar_path: null,
          avatar_updated_at: new Date().toISOString(),
        },
      })
      if (metadataError) throw metadataError

      emit(userId, null)
      return { ok: true }
    } catch (err) {
      const message = avatarErrorMessage(err)
      setError(message)
      return { ok: false, message }
    } finally {
      setBusy(false)
    }
  }, [userId, isDemo, getClient, user])

  const clearError = useCallback(() => setError(null), [])

  return { avatarUrl, hasAvatar: Boolean(avatarUrl), busy, error, clearError, saveAvatar, removeAvatar }
}
