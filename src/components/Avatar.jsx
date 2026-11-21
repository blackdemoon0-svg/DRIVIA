import { useEffect, useState } from 'react'

// Avatar rond partagé par la Topbar, la Sidebar et la page Profil.
// Si l'image distante échoue (fichier supprimé, réseau), on retombe
// proprement sur l'initiale du compte au lieu d'afficher une image cassée.
export default function Avatar({ url, initial = '?', className = '', alt = '' }) {
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    setBroken(false)
  }, [url])

  const showImage = Boolean(url) && !broken
  const classes = `avatar${className ? ` ${className}` : ''}${showImage ? ' has-photo' : ''}`

  return (
    <span className={classes}>
      {showImage ? (
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="avatar-initial" aria-hidden={alt ? undefined : 'true'}>
          {initial}
        </span>
      )}
    </span>
  )
}
