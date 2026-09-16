# RU-07 UI contract consumption checklist

| Contract / route | UI consumer | Status |
|---|---|---|
| `validatePageSelection` | submit path + 422 copy | wired |
| `ConversationResume` / turns | assistant-view refresh | wired |
| GET/POST `/api/opening/conversations` | openingApi | wired (T03) |
| POST `/api/opening/turns` | submitTurn | wired; job pending only |
| GET/POST `/api/opening/sources` | list + beginUpload (materials) | wired |
| `uploadUrl` → PUT `/api/opening/sources/:id/staging` | `resolveUploadPutUrl` + upload-strip | wired (materials canonical) |
| POST `.../complete` | completeUpload | wired (materials) |
| Memory panel | — | out of thin slice |
