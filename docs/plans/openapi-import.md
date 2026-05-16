# OpenAPI Import — Spec

Status: planned, not started.

## Context

Knock es cliente HTTP basado en archivos (TOML por request, workspace = directorio + git). Hoy no hay forma de bootstrap rápido desde un contrato existente — solo curl ↔ TOML manual via `apps/knock-app/src/tools/CurlTool.tsx`. En proyectos colaborativos, el `openapi.json` evoluciona y arrastra cambios que el equipo necesita reflejar en sus requests sin re-crear todo a mano.

Objetivos:
- Ingestar OpenAPI (URL o archivo) → generar requests automáticamente.
- Guardar el spec dentro del workspace, versionado por git, para que el equipo comparta el mismo contrato.
- Re-importar cuando el spec cambie, detectando endpoints nuevos/modificados/eliminados y dejando al usuario elegir qué aplicar.
- Vista dedicada del spec integrado (nodo especial en el árbol).
- Editar el spec en la app y propagar cambios a la lista de requests.
- Soporte OpenAPI 3.0, 3.1 y Swagger 2, formatos JSON y YAML.

## Decisiones confirmadas

| Tema | Decisión |
|---|---|
| Ubicación del spec | `openapi/` en root del workspace, versionada por git. Metadata local en `.knock/openapi/` |
| Re-import | Diff endpoint-por-endpoint con confirmación del usuario |
| Marcado de requests | Sección `[openapi]` en el TOML del request (operation_id, spec_version, generated_hash) |
| Vista | Nodo especial en `Tree.tsx` que abre panel dedicado |
| Versiones soportadas | OpenAPI 3.0 + 3.1 + Swagger 2, JSON + YAML |
| Folder layout requests | `requests/<tag>/<operationId>.toml` |
| Detección edits manuales | Hash SHA-256 del contenido generado, en `[openapi] generated_hash` |

## Estructura en disco

```
workspace/
├── knock.toml
├── openapi/                          # NUEVO — versionado por git
│   ├── spec.json (o spec.yaml)       # Spec actual (formato original preservado)
│   └── history/
│       ├── 2026-05-16T10-22-petstore-1.0.0.json
│       └── 2026-05-10T09-00-petstore-0.9.0.json
├── .knock/
│   └── openapi/                      # NUEVO — local, no versionado (ya cubierto por .knock/ en .gitignore)
│       ├── meta.json                 # { source, lastImportedAt, currentHash, currentVersion, sourceUrl }
│       └── snapshots/                # (opcional fase 2) snapshots para 3-way merge
└── requests/
    └── pets/                         # tag del spec
        ├── listPets.toml
        └── createPet.toml
```

Formato request generado:

```toml
name = "List all pets"
method = "GET"
url = "{{base_url}}/pets"

[query]
limit = ""

[openapi]
operation_id = "listPets"
path = "/pets"
spec_version = "1.0.0"
generated_hash = "sha256:abc123..."
```

Formato `.knock/openapi/meta.json`:

```json
{
  "source": "file" | "url",
  "sourceUrl": "https://api.example.com/openapi.json",
  "specFile": "openapi/spec.json",
  "specFormat": "openapi-3.1" | "openapi-3.0" | "swagger-2",
  "specVersion": "1.0.0",
  "specHash": "sha256:...",
  "lastImportedAt": 1731756000000,
  "operations": {
    "listPets": { "rel": "requests/pets/listPets.toml", "generatedHash": "sha256:..." }
  }
}
```

## Cambios — Backend (Rust)

### Dependencias nuevas (`crates/knock-core/Cargo.toml`)

- `serde_yaml = "0.9"` — parsear YAML
- `sha2 = "0.10"` — hash generado
- Reusar `serde_json` y `reqwest` existentes (descarga URL)

### Nuevo módulo `crates/knock-core/src/openapi.rs`

Responsabilidades:
- `parse_spec(bytes: &[u8], hint: SpecFormat) -> Result<NormalizedSpec>` — detecta JSON vs YAML, valida `openapi:` vs `swagger:`, normaliza Swagger 2 → modelo interno común.
- `NormalizedSpec` struct: version, title, servers, operations (Vec<Operation>).
- `Operation`: operation_id (auto-generar como `<method>_<path>` si falta), method, path, tag (primero), summary, parameters (query/header/path), request_body (JSON schema → ejemplo o vacío).
- `to_request_form(op: &Operation, base_url: &str) -> RequestFormDto` — convertir operación a request. URL = `{{base_url}}{path}` con path params como `{{param}}`. Headers/query desde parameters. Body desde request_body si es `application/json`.
- `generated_hash(form: &RequestFormDto) -> String` — SHA256 estable del TOML emitido (sin la sección `[openapi]` para evitar self-reference).

### Nuevo módulo `apps/knock-app/src-tauri/src/openapi_cmd.rs`

DTOs:

```rust
#[derive(Serialize, Deserialize)]
pub struct OpenApiSourceDto { kind: String /* "file" | "url" */, value: String }

#[derive(Serialize)]
pub struct OpenApiPreviewDto {
    spec_version: String,
    spec_format: String,
    title: Option<String>,
    operations: Vec<OpenApiOperationPreview>,
}

#[derive(Serialize)]
pub struct OpenApiOperationPreview {
    operation_id: String,
    method: String,
    path: String,
    tag: Option<String>,
    summary: Option<String>,
    target_rel: String,
    status: String, // "new" | "modified" | "unchanged" | "removed"
    existing_was_manually_edited: bool,
}

#[derive(Serialize, Deserialize)]
pub struct OpenApiApplySelectionDto {
    operation_id: String,
    action: String, // "create" | "overwrite" | "skip" | "delete"
}

#[derive(Serialize)]
pub struct OpenApiMetaDto {
    has_spec: bool,
    spec_rel: Option<String>,
    spec_format: Option<String>,
    spec_version: Option<String>,
    last_imported_at: Option<u64>,
    source_url: Option<String>,
    operation_count: usize,
}
```

Commands (registrar en `apps/knock-app/src-tauri/src/lib.rs` dentro de `invoke_handler!`):

| Command | Args | Return | Comportamiento |
|---|---|---|---|
| `openapi_fetch` | `source: OpenApiSourceDto` | `Vec<u8>` | URL → `reqwest` async GET. File → `std::fs::read` |
| `openapi_preview_import` | `root, bytes, format_hint` | `OpenApiPreviewDto` | Parsear, comparar con `meta.json` existente, marcar cada op como new/modified/unchanged/removed + flag de edición manual (hash actual del archivo vs `generated_hash` registrado) |
| `openapi_apply_import` | `root, bytes, selections: Vec<OpenApiApplySelectionDto>` | `Vec<TreeEntry>` | Para cada selección: crear/sobrescribir/borrar archivo. Mover spec previo a `openapi/history/<timestamp>-<version>.<ext>`. Escribir spec nuevo. Actualizar `.knock/openapi/meta.json`. Devolver tree refrescado |
| `openapi_get_meta` | `root` | `OpenApiMetaDto` | Leer meta.json |
| `openapi_read_spec` | `root` | `String` | Leer texto crudo de `openapi/spec.{json,yaml}` |
| `openapi_save_spec` | `root, content: String` | `OpenApiPreviewDto` | Validar + parsear el editado, devolver preview de cambios sobre los requests actuales (no aplica hasta confirmar) |
| `openapi_list_history` | `root` | `Vec<HistoryEntry>` | Listar `openapi/history/*` |

### Cambio en `crates/knock-core/src/model.rs`

Añadir campo opcional a `Request`:

```rust
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct OpenApiMark {
    pub operation_id: String,
    pub path: String,
    pub spec_version: String,
    pub generated_hash: String,
}

pub struct Request {
    // ... campos existentes
    pub openapi: Option<OpenApiMark>,
}
```

Propagar en `request_to_form` / `emit_request_toml` en `apps/knock-app/src-tauri/src/commands.rs` (líneas ~1069 y ~1141) para preservar la sección al editar/guardar requests.

### Cambio en `list_tree` / clasificación

En `apps/knock-app/src-tauri/src/commands.rs` función `classify(rel)` (~line 972): añadir kind `"openapi"` para `openapi/spec.json` o `openapi/spec.yaml`. Añadir variante en `EntryKind` (TypeScript).

## Cambios — Frontend (TS/React)

### Tipos nuevos (`apps/knock-app/src/types.ts`)

```ts
export type EntryKind = ... | "openapi";

export interface OpenApiMeta {
  hasSpec: boolean;
  specRel: string | null;
  specFormat: string | null;
  specVersion: string | null;
  lastImportedAt: number | null;
  sourceUrl: string | null;
  operationCount: number;
}

export interface OpenApiOperationPreview {
  operationId: string;
  method: string;
  path: string;
  tag: string | null;
  summary: string | null;
  targetRel: string;
  status: "new" | "modified" | "unchanged" | "removed";
  existingWasManuallyEdited: boolean;
}

export interface OpenApiPreview {
  specVersion: string;
  specFormat: string;
  title: string | null;
  operations: OpenApiOperationPreview[];
}
```

### Nuevos componentes

| Archivo | Función |
|---|---|
| `apps/knock-app/src/OpenApiImportModal.tsx` | Modal con dos pestañas: "Desde URL" (input) y "Desde archivo" (file picker via `@tauri-apps/plugin-dialog`). Botón "Previsualizar" → invoke `openapi_fetch` + `openapi_preview_import`. Muestra tabla de operaciones con status (badge color), checkbox por op, banner de warning si `existingWasManuallyEdited`. Botón "Importar seleccionados" → invoke `openapi_apply_import`. |
| `apps/knock-app/src/OpenApiView.tsx` | Panel del spec. Header con título, versión, source URL, "última importación", botones "Re-importar desde URL" / "Importar nuevo archivo". Editor de texto (reusar `Editor.tsx`) con el contenido raw del spec. Al guardar: invoke `openapi_save_spec` → muestra preview de impacto en requests → confirmar aplicar. Lista de operaciones con link a su request generado (click → `setSelected(rel)`). |

### Modificaciones a componentes existentes

- `apps/knock-app/src/Tree.tsx` (~758 LOC): renderizar nodo de kind `"openapi"` con icono especial al tope del árbol. Click → seleccionar y abrir `OpenApiView` en panel central.
- `apps/knock-app/src/App.tsx` (~1179 LOC): branch en render del panel central: si `selected === "openapi/spec.json"` (o `.yaml`) → renderizar `<OpenApiView>` en vez de `<RequestEditor>` / `<Editor>`. Entrada nueva en menú "+" del sidebar y en `Dashboard.tsx` para "Import OpenAPI".
- `apps/knock-app/src/Dashboard.tsx`: tarjeta "Import from OpenAPI" junto a las acciones de crear workspace.
- `apps/knock-app/src/RequestEditor.tsx` (~179 LOC): si el form tiene marca `openapi`, badge sutil "Generated from OpenAPI v1.0.0 · listPets" en el header. Si el usuario edita y el hash diverge: badge cambia a "Modified locally".

## Reutilización

- `safe_join`, `parent_dir_rel`, `base_name_of`, `order_append_if_exists` en `apps/knock-app/src-tauri/src/commands.rs` — usar al escribir requests generados respetando el ordering existente.
- `emit_request_toml` y `request_to_form` (`commands.rs:1069, 1141`) — base para serializar requests generados; extender para incluir `[openapi]`.
- Lógica de validación de `create_entry` (`commands.rs:518`) — replicar checks (path no vacío, no `..`).
- `parser::parse_request` en `knock-core` — leer requests existentes y comparar hash para detectar edits manuales.
- `usePersistedField` hook en `apps/knock-app/src/hooks.ts` — persistir source URL en el modal entre sesiones.
- `Editor.tsx` — editor de código TOML/JSON existente, sirve para editar el spec.
- `@tauri-apps/plugin-dialog` ya disponible — file picker.

## Fases sugeridas

1. **Fase 1 (MVP)**: Backend parse OpenAPI 3.x JSON + URL/file fetch + commands básicos. Frontend modal import + lista preview + apply. Sin edit del spec en la app, sin viewer dedicado (solo edit raw via `Editor` existente).
2. **Fase 2**: `OpenApiView` con header rico, lista de ops linkeada a requests, re-import desde la vista.
3. **Fase 3**: YAML + Swagger 2 + detección de edits manuales (hash + badge).
4. **Fase 4**: Edit del spec en la app con preview de impacto antes de aplicar.

## Verificación end-to-end

1. Build:
   ```
   cd apps/knock-app
   pnpm tauri dev
   ```

2. Crear workspace nuevo, abrir Dashboard.

3. **Import desde URL** con `https://petstore3.swagger.io/api/v3/openapi.json`:
   - Click "Import from OpenAPI" → tab URL → pegar URL → "Previsualizar".
   - Verificar lista de ops agrupada por tag (`pet`, `store`, `user`).
   - Todas marcadas `new`, sin flag de "edited".
   - Seleccionar todas → "Importar".
   - Verificar:
     - `openapi/spec.json` existe y abre el viewer.
     - `requests/pet/addPet.toml`, etc. existen.
     - Cada uno tiene sección `[openapi]` con `operation_id`, `generated_hash`.
     - `.knock/openapi/meta.json` mapea `operations`.

4. **Re-import sin cambios**: misma URL → todas `unchanged`, ninguna acción aplicada.

5. **Re-import con cambios**: editar el spec fuera de la app (cambiar summary, añadir endpoint), re-importar:
   - Nuevo endpoint → `new`. Modificado → `modified`.
   - Confirmar → archivos actualizados, `meta.json` y hashes refrescados, spec viejo movido a `openapi/history/`.

6. **Edit manual de request generado**: cambiar URL en un `.toml`, luego re-import:
   - Op marcada `modified` + `existingWasManuallyEdited: true`.
   - Banner amarillo "estos cambios sobrescribirán ediciones manuales".
   - Skip esa op → archivo intacto.

7. **Editar spec en la app**: abrir `openapi/spec.json` en viewer, modificar un path, guardar → preview de impacto → confirmar → request afectado se actualiza.

8. **YAML**: importar `https://raw.githubusercontent.com/OAI/OpenAPI-Specification/main/examples/v3.0/petstore.yaml`.

9. **Swagger 2**: importar `https://petstore.swagger.io/v2/swagger.json`.

10. **Git workflow**: `git status` en el workspace muestra `openapi/spec.json` y `requests/...` como cambios; `.knock/openapi/` ignorado (ya cubierto por `.knock/` en `.gitignore`).

## Archivos críticos a modificar

| Path | Cambio |
|---|---|
| `crates/knock-core/Cargo.toml` | +serde_yaml, +sha2 |
| `crates/knock-core/src/openapi.rs` | NUEVO — parser + normalizador + conversión a `RequestFormDto` |
| `crates/knock-core/src/lib.rs` | Re-export `openapi` |
| `crates/knock-core/src/model.rs` | +`OpenApiMark` opcional en `Request` |
| `apps/knock-app/src-tauri/src/openapi_cmd.rs` | NUEVO — commands Tauri |
| `apps/knock-app/src-tauri/src/lib.rs` | +`mod openapi_cmd` + registrar commands en `invoke_handler!` |
| `apps/knock-app/src-tauri/src/commands.rs` | Extender `classify` (kind openapi), `request_to_form` / `emit_request_toml` (preservar `[openapi]`) |
| `apps/knock-app/src/types.ts` | +EntryKind `"openapi"`, +`OpenApiMeta`/`OpenApiPreview` |
| `apps/knock-app/src/OpenApiImportModal.tsx` | NUEVO |
| `apps/knock-app/src/OpenApiView.tsx` | NUEVO |
| `apps/knock-app/src/Tree.tsx` | Render nodo openapi |
| `apps/knock-app/src/App.tsx` | Routing al `OpenApiView` + acción nueva en sidebar |
| `apps/knock-app/src/Dashboard.tsx` | Tarjeta "Import from OpenAPI" |
| `apps/knock-app/src/RequestEditor.tsx` | Badge "generated from OpenAPI" |
