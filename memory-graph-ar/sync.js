// Two-way sync between this device (IndexedDB) and the cloud, for one signed-in user.
// Push first (what changed here), then pull (what changed elsewhere). Last write wins; nothing here edits a memory in place,
// so the only real conflicts are renames. Returns true when pulling changed local data (caller reloads the camera).
//
// remote: the object from cloud.js. local: { raw(), put(place), remove(id), getSince(), setSince(iso) }.
// Local flags: place.dirty (name/row needs pushing), place.mindUp (tracking file uploaded), place.deleted (tombstone),
// place.tomb ([{id}] memories deleted here), memory.up (memory uploaded).

const toBlob = async dataUrl => (await fetch(dataUrl)).blob();
const toDataUrl = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

export async function runSync({ remote, local, uid }) {
  const dir = p => `${uid}/${p.id}`;

  /* ---- push ---- */
  for (const p of await local.raw()) {
    if (p.deleted) {
      await remote.upsertPlace({ id: p.id, owner: uid, name: p.name || 'Chỗ', deleted_at: new Date().toISOString() });
      await remote.remove([`${dir(p)}/mind.bin`, ...(p.memories || []).flatMap(m => [`${dir(p)}/${m.id}.jpg`, `${dir(p)}/${m.id}.aud`])]);
      await local.remove(p.id);
      continue;
    }
    let touched = false;
    if (!p.mindUp) {
      await remote.upload(`${dir(p)}/mind.bin`, new Blob([p.mind], { type: 'application/octet-stream' }));
      p.mindUp = true; p.dirty = true; touched = true;
    }
    if (p.dirty) {
      await remote.upsertPlace({ id: p.id, owner: uid, name: p.name, thumb: p.thumb, mind_path: `${dir(p)}/mind.bin` });
      p.dirty = false; touched = true;
    }
    for (const m of p.memories) {
      if (m.up) continue;
      if (m.photo) await remote.upload(`${dir(p)}/${m.id}.jpg`, await toBlob(m.photo));
      if (m.audio) await remote.upload(`${dir(p)}/${m.id}.aud`, await toBlob(m.audio));
      await remote.upsertMemory({
        id: m.id, place_id: p.id, owner: uid, x: m.x, y: m.y, text: m.text || '', color: m.color || null,
        audio_dur: m.audioDur || null, peaks: m.peaks?.length ? m.peaks : null,
        photo_path: m.photo ? `${dir(p)}/${m.id}.jpg` : null, audio_path: m.audio ? `${dir(p)}/${m.id}.aud` : null,
        created_at: new Date(m.t || Date.now()).toISOString(),
      });
      m.up = true; touched = true;
    }
    for (const t of p.tomb || []) {
      await remote.deleteMemory(t.id);
      await remote.remove([`${dir(p)}/${t.id}.jpg`, `${dir(p)}/${t.id}.aud`]);
      touched = true;
    }
    if (p.tomb?.length) p.tomb = [];
    if (touched) await local.put(p);
  }

  /* ---- pull ---- */
  const since = local.getSince() || '1970-01-01T00:00:00Z';
  let newest = since, changed = false;
  const byId = new Map((await local.raw()).map(p => [p.id, p]));
  const seen = r => { if (r.updated_at > newest) newest = r.updated_at; };

  for (const r of await remote.listPlaces(since)) {
    seen(r);
    const have = byId.get(r.id);
    if (r.deleted_at) {
      if (have) { await local.remove(r.id); byId.delete(r.id); changed = true; }
      continue;
    }
    if (!have) {
      const mind = new Uint8Array(await (await remote.download(r.mind_path)).arrayBuffer());
      const p = { id: r.id, name: r.name, thumb: r.thumb, mind, memories: [], mindUp: true, dirty: false };
      await local.put(p); byId.set(r.id, p); changed = true;
    } else if (!have.dirty && have.name !== r.name) {
      have.name = r.name; await local.put(have); changed = true;
    }
  }

  for (const r of await remote.listMemories(since)) {
    seen(r);
    const p = byId.get(r.place_id);
    if (!p) continue;
    const i = p.memories.findIndex(m => m.id === r.id);
    if (r.deleted_at) {
      if (i >= 0) { p.memories.splice(i, 1); await local.put(p); changed = true; }
      continue;
    }
    if (i >= 0) continue;
    const mem = { id: r.id, x: r.x, y: r.y, text: r.text, color: r.color, audioDur: r.audio_dur, peaks: r.peaks || [],
      t: Date.parse(r.created_at), up: true, photo: null, audio: null };
    if (r.photo_path) mem.photo = await toDataUrl(await remote.download(r.photo_path));
    if (r.audio_path) mem.audio = await toDataUrl(await remote.download(r.audio_path));
    p.memories.push(mem);
    await local.put(p); changed = true;
  }

  local.setSince(newest);
  return changed;
}
