// Photos de profil VEYVRO — règles partagées entre l'interface, Supabase
// Storage et les tests. Module volontairement sans React et sans client
// Supabase : les fonctions pures (validation, chemins, messages) peuvent être
// testées hors navigateur. La compression, elle, n'utilise le DOM qu'au moment
// de l'appel, jamais à l'import.

export const AVATAR_BUCKET = 'avatars'
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024
export const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export const AVATAR_MAX_DIMENSION = 512
export const AVATAR_QUALITY = 0.85

export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number]
export type AvatarExtension = 'jpg' | 'png' | 'webp'

export type AvatarFileLike = {
  type?: string | null
  size?: number | null
  name?: string | null
}

export type AvatarUserLike =
  | { user_metadata?: Record<string, unknown> | null }
  | null
  | undefined

/** Ramène les variantes MIME connues à l'une des trois acceptées. */
export function normalizeAvatarMime(type?: string | null): AvatarMimeType | null {
  const raw = String(type ?? '').trim().toLowerCase()
  if (!raw) return null
  // Certains appareils annoncent encore image/jpg ou image/pjpeg.
  if (raw === 'image/jpg' || raw === 'image/pjpeg') return 'image/jpeg'
  return (AVATAR_MIME_TYPES as readonly string[]).includes(raw) ? (raw as AvatarMimeType) : null
}

/** Devine le type depuis l'extension quand le navigateur ne fournit pas de MIME. */
export function inferAvatarMimeFromName(name?: string | null): AvatarMimeType | null {
  const value = String(name ?? '').trim().toLowerCase()
  const dot = value.lastIndexOf('.')
  if (dot < 0 || dot === value.length - 1) return null
  const extension = value.slice(dot + 1)
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'png') return 'image/png'
  if (extension === 'webp') return 'image/webp'
  return null
}

/** Extension de stockage à partir du type réellement produit par le canvas. */
export function avatarExtensionFromMime(type?: string | null): AvatarExtension {
  const mime = normalizeAvatarMime(type)
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  return 'jpg'
}

/** Taille lisible, avec la virgule décimale française. */
export function formatAvatarSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 Ko'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`
  const megabytes = Math.round((bytes / (1024 * 1024)) * 10) / 10
  const label = Number.isInteger(megabytes)
    ? String(megabytes)
    : megabytes.toFixed(1).replace('.', ',')
  return `${label} Mo`
}

/**
 * Valide le fichier choisi AVANT compression.
 * Retourne null si tout va bien, sinon une phrase affichable telle quelle.
 */
export function validateAvatarFile(file?: AvatarFileLike | null): string | null {
  if (!file) return 'Choisissez une photo.'
  const size = typeof file.size === 'number' ? file.size : 0
  if (size <= 0) return "Cette image est vide ou illisible. Choisissez-en une autre."
  if (size > AVATAR_MAX_BYTES) {
    return `Cette image dépasse la limite de ${formatAvatarSize(AVATAR_MAX_BYTES)}.`
  }
  const announced = String(file.type ?? '').trim()
  // Un type annoncé mais interdit est refusé même si l'extension semble bonne :
  // on ne se fie pas à un nom de fichier trafiqué.
  if (announced) {
    if (!normalizeAvatarMime(announced)) return unsupportedFormatMessage()
    return null
  }
  // Type absent (fréquent sur certains mobiles) : on accepte uniquement si le
  // nom porte une extension JPG, PNG ou WEBP.
  if (inferAvatarMimeFromName(file.name)) return null
  return unsupportedFormatMessage()
}

function unsupportedFormatMessage(): string {
  return 'Format non pris en charge. Utilisez une image JPG, PNG ou WEBP.'
}

/** Chemin Storage : un dossier par identifiant utilisateur, un seul fichier. */
export function avatarStoragePath(userId: string, extension: string): string {
  const id = String(userId ?? '').trim()
  if (!id) throw new Error('Identifiant utilisateur manquant.')
  // Le dossier doit être exactement auth.uid() pour que les politiques RLS
  // puissent le vérifier ; aucun segment supplémentaire n'est accepté.
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error('Identifiant utilisateur invalide.')
  }
  const ext = String(extension ?? '').replace(/^\./, '').trim().toLowerCase()
  if (ext === 'jpeg') return `${id}/avatar.jpg`
  if (ext !== 'jpg' && ext !== 'png' && ext !== 'webp') {
    throw new Error("Extension d'image non prise en charge.")
  }
  return `${id}/avatar.${ext}`
}

/** Lit l'URL de la photo enregistrée dans les métadonnées du compte. */
export function readAvatarUrl(user: AvatarUserLike): string | null {
  const value = readMetadata(user, 'avatar_url')
  if (typeof value !== 'string') return null
  const url = value.trim()
  if (!url) return null
  // Seules les URL affichables sont rendues : jamais de javascript: ou de
  // fichier local injecté dans l'attribut src.
  if (!/^(https?:\/\/|data:image\/)/i.test(url)) return null
  return url
}

/** Lit le chemin Storage enregistré dans les métadonnées du compte. */
export function readAvatarPath(user: AvatarUserLike): string | null {
  const value = readMetadata(user, 'avatar_path')
  if (typeof value !== 'string') return null
  const path = value.trim()
  if (!path || path.startsWith('/') || path.includes('..')) return null
  return path
}

function readMetadata(user: AvatarUserLike, key: string): unknown {
  const metadata = user?.user_metadata
  if (!metadata || typeof metadata !== 'object') return null
  return (metadata as Record<string, unknown>)[key]
}

/**
 * Traduit une erreur Supabase/Storage en message actionnable.
 * L'ordre des tests compte : une violation RLS contient aussi « auth ».
 */
export function avatarErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''
  const message = raw.toLowerCase()
  if (!message) return "L'enregistrement de la photo a échoué. Réessayez dans un instant."
  if (message.includes('bucket not found') || message.includes('bucket does not exist')) {
    return "Le bucket « avatars » n'existe pas encore : exécutez la migration SQL 0003 dans Supabase, puis réessayez."
  }
  if (
    message.includes('row-level security') ||
    message.includes('row level security') ||
    message.includes('policy') ||
    message.includes('permission denied') ||
    message.includes('unauthorized')
  ) {
    return "Le stockage refuse cette opération : vérifiez les politiques du bucket « avatars » et que vous êtes bien connecté."
  }
  if (
    message.includes('too large') ||
    message.includes('maximum allowed size') ||
    message.includes('payload') ||
    message.includes('exceeded')
  ) {
    return `Cette image dépasse la limite de ${formatAvatarSize(AVATAR_MAX_BYTES)}.`
  }
  if (
    message.includes('mime') ||
    message.includes('content type') ||
    message.includes('content-type')
  ) {
    return unsupportedFormatMessage()
  }
  if (
    message.includes('jwt') ||
    message.includes('session') ||
    message.includes('not authenticated') ||
    message.includes('invalid claim')
  ) {
    return 'Votre session a expiré. Reconnectez-vous puis réessayez.'
  }
  if (message.includes('failed to fetch') || message.includes('network') || message.includes('load failed')) {
    return 'Réseau indisponible : vérifiez votre connexion puis réessayez.'
  }
  return "L'enregistrement de la photo a échoué. Réessayez dans un instant."
}

type LoadedImage = ImageBitmap | HTMLImageElement

async function loadImage(file: Blob): Promise<LoadedImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      // imageOrientation respecte les photos portrait prises au téléphone.
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      try {
        return await createImageBitmap(file)
      } catch {
        throw new Error("Cette image n'a pas pu être lue. Essayez une autre photo.")
      }
    }
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error("Cette image n'a pas pu être lue. Essayez une autre photo."))
      image.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

function closeImage(image: LoadedImage) {
  if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close()
}

/**
 * Redimensionne (max 512 px) et recompresse en WebP.
 * Une photo de 4 Mo tombe généralement sous 150 Ko. Si le navigateur n'encode
 * pas le WebP, canvas.toBlob renvoie du PNG, également accepté par le bucket.
 */
export async function compressAvatarImage(
  file: Blob,
  options: { maxDimension?: number; quality?: number } = {}
): Promise<Blob> {
  if (typeof document === 'undefined' || typeof Blob === 'undefined') {
    throw new Error("La compression d'image n'est pas disponible dans cet environnement.")
  }
  const maxDimension = options.maxDimension ?? AVATAR_MAX_DIMENSION
  const quality = options.quality ?? AVATAR_QUALITY
  const image = await loadImage(file)
  try {
    const sourceWidth = image.width
    const sourceHeight = image.height
    if (!sourceWidth || !sourceHeight) {
      throw new Error("Cette image n'a pas pu être lue. Essayez une autre photo.")
    }
    const ratio = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight))
    const width = Math.max(1, Math.round(sourceWidth * ratio))
    const height = Math.max(1, Math.round(sourceHeight * ratio))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error("Cette image n'a pas pu être préparée.")
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, width, height)

    if (typeof canvas.toBlob !== 'function') {
      throw new Error("Cette image n'a pas pu être compressée.")
    }
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/webp', quality)
    })
    if (!blob || blob.size === 0) throw new Error("Cette image n'a pas pu être compressée.")
    return blob
  } finally {
    closeImage(image)
  }
}
