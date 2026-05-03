# Sourcing style LoRAs

This project's `genStack: "sdxl-stylized"` configuration uses a 2-LoRA stack at
inference time:

1. **Style LoRA** — defines the visual aesthetic (MS Paint, doodle, sketch, etc.)
2. **Identity LoRA** — locks the character's face/proportions

The identity LoRA is trained from your own reference images via the `/bot` LoRA
panel. The style LoRA needs to be **sourced externally** since training one
requires hundreds of stylistically-coherent images and isn't economical for a
single project.

This doc covers where to find good style LoRAs and how to attach them.

## Where to find style LoRAs

### Civitai (largest catalog)

https://civitai.com — biggest community catalog of SDXL LoRAs. Free download
for most models, paid Early Access for a few. Filters: model type = LoRA,
base model = SDXL.

For Spurdo specifically, search:
- `MS Paint` — couple of models, mostly Early Access
- `amateur drawing`
- `doodle style`
- `simple drawing`
- `child drawing`
- `crude cartoon`

### HuggingFace

https://huggingface.co/models?other=lora&pipeline_tag=text-to-image — large
catalog, fully free, more research-y models. Less curated UI but downloads
are direct `.safetensors` URLs.

### Tensor.Art

https://tensor.art — alternative community site. Has an `MSPaint Art Style
[SDXL Version]` model. Mixed quality but worth checking.

## Attaching a style LoRA to this project

Once you have a style LoRA URL (a public `.safetensors` link), edit
`config/spurdo/image-prompts.json`:

```json
"stackConfig": {
  "stack": "sdxl-stylized",
  "defaultStyleLoras": [
    {
      "url": "https://example.com/path/to/ms-paint-style.safetensors",
      "role": "style",
      "scale": 0.9,
      "label": "ms-paint",
      "triggerWord": "mspaint"
    }
  ]
}
```

Field meanings:

- **url** — direct download URL to the `.safetensors` file. Civitai requires
  account auth for some downloads; in those cases, download the file locally
  then re-upload to Fal storage via the LoRA training UI's "upload" helper
  (or use a public bucket like S3/R2).
- **role** — `"style"` (always for style LoRAs; identity LoRAs are added
  separately at inference via the registry).
- **scale** — 0.7-1.1 typically works. Higher pushes the style harder but
  can over-saturate. Start at 0.9.
- **label** — human-readable, shows up in dashboard logs.
- **triggerWord** — if the LoRA was trained with a specific token (most have
  one in their Civitai page docs), put it here. The dispatcher prepends it
  to the prompt automatically. Optional but improves results.

## Why not train our own style LoRA?

You could. It would take:
- ~200 hand-curated MS-Paint-style images (different subjects, all same style)
- ~$10 in Fal training credits
- ~30 min of training + iteration

Worth it if existing community LoRAs don't capture the exact aesthetic you
want. For Spurdo specifically, an existing MS Paint LoRA is good enough as a
starting point.

## Why bank still wins for Spurdo specifically

Even with a perfect style LoRA stack, generated images will always be one
step removed from authentic imageboard memes. The bank approach (memedepot
scraping) gives you the actual canon material the project is built on. Use
generation as a complement (e.g., for novel scenes the bank doesn't cover)
rather than a replacement.

## Multiple stacked style LoRAs

You can put more than one style LoRA in `defaultStyleLoras`. Common pattern:
one for the broad aesthetic, one for a specific detail (e.g., "amateur lines"
+ "flat color fills"). Be careful — too many LoRAs at inference fight each
other and produce muddied output. 1-2 style LoRAs is the sweet spot.
