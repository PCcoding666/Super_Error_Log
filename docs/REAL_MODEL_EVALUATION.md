# Bounded Bailian real-model evaluation

This evaluator compares multimodal models on the same human-reviewed stage inputs used by the application. It evaluates the five evidence-pipeline stages (`layout`, `transcribe`, `diagnose`, `coach`, and `match`); it is not an OCR benchmark. This repository does not include a reference dataset, score cards, fabricated live calls, or a preselected winner.

Every quality score comes from an external human score card. Model output never grades itself. A ranking applies only to the recorded dataset, region, prompt version, and settings—not to the model universally.

## Verified model catalog

Prices are CNY per one million input/output tokens, verified 2026-09-07.

| Model ID | Beijing | Singapore | Official source |
| --- | ---: | ---: | --- |
| `qwen3.8-27b` | 3 / 12 | 3.646 / 21.875 | [Qwen3.8-27B pricing](https://help.aliyun.com/zh/model-studio/qwen3-8-27b) |
| `qwen3.8-max-0902` | 12 / 36 | 14.988 / 44.965 | [Qwen3.8-Max pricing](https://help.aliyun.com/zh/model-studio/qwen3-8-max) |
| `qwen3.8-flash` | 0.8 / 2.7 | 1.094 / 3.427 | [Qwen3.8-Flash pricing](https://help.aliyun.com/zh/model-studio/qwen3-8-flash) |

All calls use temperature 0, thinking disabled, an 8,192-token output cap, and a conservative 100,000-token input ceiling. The model ID, settings, regional rates, source URL, verification date, prompt version, input hash, and normalized-image hash are copied into every result.

## Manifest version 1

`budgetCny` and `maxCalls` may be omitted for a dry-run preview, but both are mandatory, positive, and finite/integer respectively for `--live`. All candidate model IDs must come from the verified catalog above. Case IDs and model IDs must be unique.

```json
{
  "version": 1,
  "region": "beijing",
  "budgetCny": 2.0,
  "maxCalls": 6,
  "candidateModels": ["qwen3.8-flash", "qwen3.8-27b"],
  "cases": [
    {
      "id": "layout-page-001",
      "stage": "layout",
      "sourcePath": "./private-evaluation/page-001.jpg",
      "groundTruth": {
        "reviewed": true,
        "notes": "Teacher checked the complete question boundaries on this page."
      }
    },
    {
      "id": "diagnose-item-013",
      "stage": "diagnose",
      "evidence": {
        "version": 1,
        "questionNumber": "13",
        "questionText": "Human-checked complete question text",
        "subject": "数学",
        "chapter": "",
        "knowledgeTags": ["根与系数"],
        "questionType": "计算",
        "questionRegion": { "x": 0, "y": 0, "width": 1, "height": 1 },
        "requiresDiagram": false,
        "regions": [],
        "observations": [
          {
            "id": "o1",
            "kind": "student_work",
            "text": "Human-checked transcription of the student's work",
            "regionId": null,
            "confidence": 1
          }
        ],
        "uncertainties": []
      },
      "groundTruth": {
        "reviewed": true,
        "notes": "Teacher checked the source and evidence fields before evaluation."
      }
    }
  ]
}
```

The stage-specific required fields are:

| Stage | Required input | Optional visual input |
| --- | --- | --- |
| `layout` | `sourcePath` | — |
| `transcribe` | `sourcePath`, `region` (`QuestionRegion`) | — |
| `diagnose` | `evidence` | `sourcePath` |
| `coach` | `evidence`, `diagnosis` | `sourcePath` |
| `match` | `sourcePath`, nonempty `candidateShortIds` | — |

`sourcePath` must be a readable local image. It is normalized through the application's `normalizePhoto` path to a local JPEG before calls; the normalized bytes supply the recorded file hash. `groundTruth.notes` is retained for human review and experiment identity but is not sent to the model.

## Commands and configuration

Dry-run is the default. It validates the manifest and prints planned call count, worst-case reservation, and whether configured caps fit. It neither reads a secret nor creates the output directory.

```bash
node --import tsx src/cli/evaluate.ts ./private-evaluation/manifest.json ./private-evaluation/run-001
```

Live evaluation is explicit:

```bash
export SEL_AI_API_KEY='configured-locally'
export SEL_AI_BASE_URL='https://dashscope.aliyuncs.com/compatible-mode/v1'
node --import tsx src/cli/evaluate.ts ./private-evaluation/manifest.json ./private-evaluation/run-001 --live
```

Use `https://dashscope.aliyuncs.com/compatible-mode/v1` for `beijing`, or `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` for `singapore`. The runner rejects missing credentials, missing live caps, nonofficial endpoints, or an endpoint/region mismatch before any request. Credentials are never stored in results or reports.

Calls are sequential. Before each call the runner atomically persists a worst-case reservation:

```text
(100000 × input_rate + 8192 × output_rate) / 1000000
```

It stops before a reservation would exceed `budgetCny` or `maxCalls`. Once usage is known, the charged estimate uses returned prompt/completion tokens; unknown usage retains the conservative reservation. A crash leaves its reservation charged, and failures are not retried automatically. A per-output-directory lock rejects concurrent runs.

An identical restart skips existing success, failure, and reserved entries. Changes to the manifest, source bytes, prompt version, model catalog/rates, region, or settings change experiment identity and require a new output directory. There is no automatic winner deployment.

## Human score cards and reporting

Important: a result file's `status=succeeded` means the API returned a response accepted by the stage schema. It does **not** mean the question text is complete, the crop is complete/clean, or the answer is correct. In inspection/contact-sheet labels use `API/schema: succeeded | CONTENT: NOT CHECKED`, never an unqualified “success”. Crop content verification is described in [CROP_COMPLETENESS.md](./CROP_COMPLETENESS.md); automatic review does not create a human score card.

After reviewing successful result JSON files, create `<output-dir>/scorecards.json` as a JSON array. Copy both `resultId` and `resultHash` from the exact result being reviewed.

```json
[
  {
    "version": 1,
    "resultId": "copy-from-result-json",
    "resultHash": "copy-from-result-json",
    "quality": 87,
    "criticalErrors": 0,
    "reviewedBy": "teacher-or-reviewer-id",
    "notes": "Checked against the original image and reviewed stage input."
  }
]
```

`quality` is 0–100. `criticalErrors` is a nonnegative integer. Reviewer and notes must be nonempty. A changed/mismatched result hash is rejected.

Generate `<output-dir>/report.json` and print the same report:

```bash
node --import tsx src/cli/evaluate.ts ./private-evaluation/manifest.json ./private-evaluation/run-001 --report
```

Stage statuses are:

- `not_run`: no result exists for the stage.
- `awaiting_review`: at least one successful result lacks a score card, no successful human-reviewed result exists, a crash reservation is incomplete, candidates do not have identical case/input sets, or experiment/configuration identities differ. `winners` stays empty.
- `ranked`: every candidate has the identical case/input set and experiment configuration, every successful result has a matching score card, and at least one reviewed success exists. Failed results receive quality 0 and remain in the denominator.

Candidate summaries include average human quality, case/failure/critical-error counts, total duration, returned usage and estimated actual cost when fully known, plus charged cost including conservative reservations. Any candidate with a critical error or no successful human-reviewed result is ineligible to win. Equal eligible top averages remain an explicit tie. Report generation also verifies that the supplied manifest and every result belong to the output directory's saved experiment identity.
