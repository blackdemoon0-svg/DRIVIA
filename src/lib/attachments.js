// Préparation des pièces jointes — contrat identique à la production :
// images -> { type: 'image', dataUrl }, PDF -> pages rendues en images { type: 'image', dataUrl }.
// Limites : 12 Mo par fichier, volume total plafonné.

const MAX_FILE_BYTES = 12 * 1024 * 1024
const MAX_TOTAL_CHARS = 6_000_000
const MAX_PDF_PAGES = 6
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/heic', 'image/heif']

export function isPdf(file) {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

export function isImage(file) {
  return (
    IMAGE_TYPES.includes(file.type.toLowerCase()) || /\.(jpe?g|png|webp|avif|heic|heif)$/i.test(file.name)
  )
}

export function validateFile(file) {
  if (!file) return 'Aucun fichier sélectionné.'
  if (file.size === 0) return 'Le fichier sélectionné est vide.'
  if (file.size > MAX_FILE_BYTES) return 'Le fichier dépasse la limite de 12 Mo.'
  if (!isPdf(file) && !isImage(file))
    return 'Format non pris en charge. Importez une photo JPG, PNG, WebP, HEIC ou AVIF, ou un PDF.'
  return null
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Impossible de lire ce fichier.'))
    reader.readAsDataURL(file)
  })
}

async function renderPdf(file) {
  const pdfjs = await import('pdfjs-dist')
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const buffer = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data: buffer }).promise
  const pages = Math.min(doc.numPages, MAX_PDF_PAGES)
  const attachments = []
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: 1.6 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')
    await page.render({ canvasContext: ctx, viewport }).promise
    attachments.push({ type: 'image', dataUrl: canvas.toDataURL('image/jpeg', 0.82), name: `${file.name} — p.${i}` })
    page.cleanup()
  }
  await doc.destroy()
  return attachments
}

export async function prepareAttachments(file) {
  const invalid = validateFile(file)
  if (invalid) throw new Error(invalid)
  let attachments
  if (isPdf(file)) {
    attachments = await renderPdf(file)
  } else {
    attachments = [{ type: 'image', dataUrl: await readAsDataUrl(file), name: file.name }]
  }
  const total = attachments.reduce((acc, a) => acc + (a.type === 'image' ? a.dataUrl.length : a.text.length), 0)
  if (total > MAX_TOTAL_CHARS)
    throw new Error("Le document est trop volumineux pour être envoyé. Essayez de réduire le nombre de pages ou la taille de l'image.")
  return attachments
}
