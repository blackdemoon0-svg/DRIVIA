/**
 * VEYVRO — photos de profil.
 *
 * Vérifications hors réseau et hors navigateur :
 *   * les règles de validation (JPG / PNG / WEBP, 5 Mo) ;
 *   * le chemin Storage (un dossier par utilisateur, une seule photo) ;
 *   * la lecture des métadonnées du compte et les messages d'erreur ;
 *   * le câblage réel : ProfileView, Topbar, Sidebar et le dialogue ;
 *   * la migration SQL : bucket, limites, politiques « propres fichiers ».
 *
 * Aucun accès Supabase, aucune variable d'environnement : pure lecture.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AVATAR_BUCKET,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_DIMENSION,
  AVATAR_MIME_TYPES,
  AVATAR_QUALITY,
  avatarErrorMessage,
  avatarExtensionFromMime,
  avatarStoragePath,
  formatAvatarSize,
  inferAvatarMimeFromName,
  normalizeAvatarMime,
  readAvatarPath,
  readAvatarUrl,
  validateAvatarFile,
} from "../src/lib/avatar.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
let checks = 0;
const pass = (label) => {
  checks += 1;
  console.log(`PASS  ${label}`);
};

const file = (type, size, name = "photo") => ({ type, size, name });

// ---------------------------------------------------------------------------
// 1. Formats et limite de taille
// ---------------------------------------------------------------------------
assert.equal(AVATAR_BUCKET, "avatars");
assert.equal(AVATAR_MAX_BYTES, 5 * 1024 * 1024);
assert.deepEqual([...AVATAR_MIME_TYPES], ["image/jpeg", "image/png", "image/webp"]);
assert.equal(AVATAR_MAX_DIMENSION, 512);
assert.ok(AVATAR_QUALITY >= 0.7 && AVATAR_QUALITY <= 0.9, "compression raisonnable");
pass("bucket « avatars », 5 Mo, JPG/PNG/WEBP, redimensionnement 512 px");

// ---------------------------------------------------------------------------
// 2. Validation des fichiers
// ---------------------------------------------------------------------------
for (const type of AVATAR_MIME_TYPES) {
  assert.equal(validateAvatarFile(file(type, 4.9 * 1024 * 1024)), null, `${type} accepté`);
}
assert.equal(validateAvatarFile(file("image/jpg", 1024)), null, "image/jpg toléré");
assert.equal(
  validateAvatarFile(file("", 1200, "portrait.WEBP")),
  null,
  "type absent mais extension WEBP acceptée"
);
assert.equal(
  validateAvatarFile(file("", 1200, "portrait.jpeg")),
  null,
  "type absent mais extension JPEG acceptée"
);

assert.match(String(validateAvatarFile(null)), /Choisissez une photo/);
assert.match(String(validateAvatarFile(file("image/png", 0))), /vide ou illisible/);
assert.match(
  String(validateAvatarFile(file("image/png", AVATAR_MAX_BYTES + 1))),
  /limite de 5 Mo/
);
assert.match(String(validateAvatarFile(file("image/gif", 1024))), /JPG, PNG ou WEBP/);
assert.match(String(validateAvatarFile(file("image/svg+xml", 1024))), /JPG, PNG ou WEBP/);
assert.match(String(validateAvatarFile(file("image/heic", 1024))), /JPG, PNG ou WEBP/);
assert.match(
  String(validateAvatarFile(file("text/plain", 1024, "photo.png"))),
  /JPG, PNG ou WEBP/,
  "un type MIME interdit n'est jamais sauvé par l'extension"
);
assert.match(String(validateAvatarFile(file("", 1024, "photo.gif"))), /JPG, PNG ou WEBP/);
pass("validation : formats refusés explicitement, 5 Mo maximum");

// ---------------------------------------------------------------------------
// 3. Normalisation MIME et extensions
// ---------------------------------------------------------------------------
assert.equal(normalizeAvatarMime("IMAGE/JPG"), "image/jpeg");
assert.equal(normalizeAvatarMime("image/pjpeg"), "image/jpeg");
assert.equal(normalizeAvatarMime("image/webp"), "image/webp");
assert.equal(normalizeAvatarMime("image/gif"), null);
assert.equal(inferAvatarMimeFromName("photo.JPG"), "image/jpeg");
assert.equal(inferAvatarMimeFromName("photo.jpeg"), "image/jpeg");
assert.equal(inferAvatarMimeFromName("photo.png"), "image/png");
assert.equal(inferAvatarMimeFromName("photo.heic"), null);
assert.equal(avatarExtensionFromMime("image/png"), "png");
assert.equal(avatarExtensionFromMime("image/webp"), "webp");
assert.equal(avatarExtensionFromMime("image/jpeg"), "jpg");
pass("normalisation des types et des extensions");

// ---------------------------------------------------------------------------
// 4. Chemin Storage : un dossier par utilisateur, fichier stable
// ---------------------------------------------------------------------------
const uid = "1f6f2bde-8f74-4f8f-9a4c-41df7b0f4f2a";
assert.equal(avatarStoragePath(uid, "webp"), `${uid}/avatar.webp`);
assert.equal(avatarStoragePath(uid, "png"), `${uid}/avatar.png`);
assert.equal(avatarStoragePath(uid, "jpeg"), `${uid}/avatar.jpg`);
assert.throws(() => avatarStoragePath("", "webp"), /Identifiant utilisateur manquant/);
assert.throws(() => avatarStoragePath("../autre", "webp"), /Identifiant utilisateur invalide/);
assert.throws(() => avatarStoragePath("a/b", "webp"), /Identifiant utilisateur invalide/);
assert.throws(() => avatarStoragePath(uid, "gif"), /Extension d'image non prise en charge/);
pass("chemin Storage : un seul fichier par utilisateur, entrée assainie");

// ---------------------------------------------------------------------------
// 5. Métadonnées du compte
// ---------------------------------------------------------------------------
const withAvatar = {
  user_metadata: {
    avatar_url: "https://project.supabase.co/storage/v1/object/public/avatars/uid/avatar.webp?v=1",
    avatar_path: "uid/avatar.webp",
  },
};
assert.match(String(readAvatarUrl(withAvatar)), /^https:\/\/project\.supabase\.co/);
assert.equal(readAvatarPath(withAvatar), "uid/avatar.webp");
assert.equal(readAvatarUrl({ user_metadata: { avatar_url: null } }), null);
assert.equal(readAvatarUrl({ user_metadata: { avatar_url: "" } }), null);
assert.equal(readAvatarUrl({ user_metadata: { avatar_url: "javascript:alert(1)" } }), null);
assert.equal(readAvatarUrl({ user_metadata: { avatar_url: "data:image/png;base64,AAAA" } }).slice(0, 15), "data:image/png;");
assert.equal(readAvatarPath({ user_metadata: { avatar_path: "../secret" } }), null);
assert.equal(readAvatarUrl(null), null);
assert.equal(readAvatarUrl(undefined), null);
pass("lecture des métadonnées : URL et chemin validés, aucune injection");

// ---------------------------------------------------------------------------
// 6. Messages d'erreur actionnables
// ---------------------------------------------------------------------------
assert.match(avatarErrorMessage(new Error("Bucket not found")), /migration SQL 0003/);
assert.match(avatarErrorMessage(new Error("new row violates row-level security policy")), /politiques du bucket/);
assert.match(avatarErrorMessage(new Error("JWT expired")), /session a expiré/);
assert.match(avatarErrorMessage(new Error("Failed to fetch")), /Réseau indisponible/);
assert.match(avatarErrorMessage(new Error("The object exceeded the maximum allowed size")), /5 Mo/);
assert.match(avatarErrorMessage(new Error("mime type image/gif is not supported")), /JPG, PNG ou WEBP/);
assert.match(avatarErrorMessage(""), /échoué/);
assert.match(avatarErrorMessage({ opaqueness: true }), /échoué/);
pass("erreurs traduites : bucket manquant, RLS, session, réseau, taille, format");

// ---------------------------------------------------------------------------
// 7. Taille lisible
// ---------------------------------------------------------------------------
assert.equal(formatAvatarSize(512), "1 Ko");
assert.equal(formatAvatarSize(1536), "2 Ko");
assert.equal(formatAvatarSize(2.4 * 1024 * 1024), "2,4 Mo");
assert.equal(formatAvatarSize(AVATAR_MAX_BYTES), "5 Mo");
pass("tailles lisibles en français");

// ---------------------------------------------------------------------------
// 8. Câblage de l'interface
// ---------------------------------------------------------------------------
const profile = read("src/components/ProfileView.jsx");
const topbar = read("src/components/Topbar.jsx");
const sidebar = read("src/components/Sidebar.jsx");
const dialog = read("src/components/ProfilePhotoDialog.jsx");
const hook = read("src/lib/useAvatar.js");

for (const [name, source] of [["ProfileView", profile], ["Topbar", topbar], ["Sidebar", sidebar]]) {
  assert.match(source, /useAvatar/, `${name} lit l'avatar`);
  assert.match(source, /Avatar/, `${name} rend l'avatar rond`);
}
assert.match(profile, /Add a profile pic/);
assert.match(profile, /Upload your photo/);
assert.match(profile, /Supprimer/);
assert.match(dialog, />Gallery</);
assert.match(dialog, />Camera</);
assert.match(dialog, /Save photo/);
assert.match(dialog, /accept="image\/jpeg,image\/png,image\/webp"/);
assert.match(dialog, /capture="user"/);
assert.match(dialog, /URL\.createObjectURL/, "aperçu local avant validation");
assert.match(dialog, /URL\.revokeObjectURL/, "l'aperçu est libéré");
assert.match(hook, /client\.storage\.from\(AVATAR_BUCKET\)/);
assert.match(hook, /\.upload\(/);
assert.match(hook, /upsert: true/);
assert.match(hook, /avatar_url/);
assert.match(hook, /avatar_path/);
assert.match(hook, /client\.auth\.updateUser/);
assert.match(hook, /\.remove\(/);
assert.match(hook, /compressAvatarImage/);
pass("interface et hook : Gallery/Camera, aperçu, Save photo, bascule, suppression");

// ---------------------------------------------------------------------------
// 9. Migration SQL
// ---------------------------------------------------------------------------
const sql = read("supabase/migrations/0003_avatars_storage.sql");
assert.match(sql, /insert into storage\.buckets/i);
assert.match(sql, /'avatars'/);
assert.match(sql, /5242880/);
assert.match(sql, /allowed_mime_types/);
assert.match(sql, /image\/jpeg/);
assert.match(sql, /image\/png/);
assert.match(sql, /image\/webp/);
assert.match(sql, /storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/);
assert.match(sql, /avatars_public_read/);
assert.match(sql, /avatars_insert_own/);
assert.match(sql, /avatars_update_own/);
assert.match(sql, /avatars_delete_own/);
assert.match(sql, /to authenticated/);
assert.doesNotMatch(sql, /with check \(\s*true\s*\)/i, "aucune politique d'écriture ouverte à tous");
assert.doesNotMatch(sql, /drop table/i);
assert.doesNotMatch(sql, /delete from/i);
pass("migration : bucket, limites, lecture publique, écriture limitée au dossier personnel");

// ---------------------------------------------------------------------------
// 10. Aucune dépendance au backend Paddle ni au chat
// ---------------------------------------------------------------------------
for (const [name, source] of [
  ["useAvatar", hook],
  ["ProfilePhotoDialog", dialog],
  ["ProfileView", profile],
]) {
  assert.doesNotMatch(source, /from ['"][^'"]*paddle/i, `${name} n'importe aucun module Paddle`);
  assert.doesNotMatch(source, /chatApi|useChat/, `${name} ne touche pas au chat`);
}
pass("aucune modification fonctionnelle de Paddle ou du chat");

console.log(`\n${checks}/${checks} vérifications photo de profil réussies.`);
