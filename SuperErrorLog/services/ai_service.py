import base64
import json
import logging
import mimetypes
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


REQUIRED_AI_FIELDS = (
    "question",
    "student_answer",
    "solution",
    "error_reason",
    "subject",
    "knowledge_point",
)

logger = logging.getLogger(__name__)
SECRET_PATTERN = re.compile(r"sk-[A-Za-z0-9._-]+")

REAL_AI_SYSTEM_PROMPT = """
你是一个面向初中学生的 AI 错题复习助手。你必须严格根据用户上传的试卷图片识别错题信息。原图是唯一事实来源。不要编造，不要输出示例，不要输出占位文本，不要输出 Mock AI 文案。

如果图片中有多道题，优先选择：
1. 有学生手写过程的题目
2. 有红叉、圈画、批改痕迹的题目
3. 学生明显做错或订正过的题目
4. 图像最清晰、最适合复习的一道题

只输出一个 JSON 对象，不要 Markdown 代码块，不要额外解释。

JSON 必须且只能包含以下字符串字段：
{
  "question": "从图片中还原的题目原文。尽量保留条件、选项、图形信息和问题。如果局部看不清，写【局部无法识别】。",
  "student_answer": "学生图片中的实际作答、计算过程、选择答案或订正痕迹。只记录图片中真实出现的内容；没有则返回空字符串。",
  "solution": "该题正确解法。用清晰步骤说明关键推理、公式和计算过程。",
  "error_reason": "学生出错原因。必须具体，例如审题遗漏、符号错误、计算错误、概念混淆、公式误用、步骤跳跃等。",
  "subject": "学科名称，例如数学、语文、英语、物理、生物、地理、历史、道法等。无法判断时返回空字符串。",
  "knowledge_point": "具体知识点，例如一元一次方程、整式加减、几何角度计算、文言文实词、英语时态等。不要只写学科大类。"
}

严格规则：
- 不允许输出 “Mock AI”
- 不允许输出 “请根据原图校对”
- 不允许输出 “示例”
- 不允许输出占位内容
- 不允许凭空添加学生没有写出的答案
- 看不清的地方必须标记【局部无法识别】
- 所有字段必须是字符串
- 输出必须能被 json.loads 直接解析
""".strip()

REAL_AI_USER_PROMPT = """
请识别这张真实试卷图片中的一道最适合复习的错题，并严格输出可被 json.loads 直接解析的 JSON 对象。不要输出 “Mock AI”、示例、占位内容或 Markdown 代码块。
""".strip()


@dataclass(frozen=True)
class AIAnalysis:
    fields: dict[str, str]
    raw_response: str
    parse_error: str | None


class AIProvider(Protocol):
    def analyze(self, image_path: str, focus_hint: str | None = None) -> str:
        """Return the provider raw response as text."""


class MockAIProvider:
    def analyze(self, image_path: str, focus_hint: str | None = None) -> str:
        return json.dumps(
            {
                "question": "Mock AI 识别题目：请根据原图校对题干。",
                "student_answer": "Mock AI 识别学生答案：这里会显示学生的原始作答。",
                "solution": "Mock AI 正确解法：先理解题意，再按步骤求解。",
                "error_reason": "Mock AI 错因：概念理解不稳或审题不清。",
                "subject": "数学",
                "knowledge_point": "Mock AI 知识点",
            },
            ensure_ascii=False,
        )


class DashScopeAIProvider:
    def __init__(self, *, api_key: str | None, base_url: str, model: str):
        self.api_key = api_key
        self.base_url = base_url
        self.model = model

    def analyze(self, image_path: str, focus_hint: str | None = None) -> str:
        if not self.api_key:
            raise ValueError("DASHSCOPE_API_KEY is required when AI_MODE=real")

        from openai import OpenAI

        image = Path(image_path)
        mime_type = mimetypes.guess_type(image.name)[0] or "image/png"
        image_data = base64.b64encode(image.read_bytes()).decode("utf-8")
        image_url = f"data:{mime_type};base64,{image_data}"
        client = OpenAI(api_key=self.api_key, base_url=self.base_url)

        user_prompt = REAL_AI_USER_PROMPT
        if focus_hint:
            user_prompt = (
                f"{REAL_AI_USER_PROMPT}\n\n"
                f"学生指定识别范围：{focus_hint}。必须优先只分析该区域内的题目、"
                "学生答案和批改痕迹；不要选择该区域外的题目。"
            )

        response = client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": REAL_AI_SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_prompt},
                        {"type": "image_url", "image_url": {"url": image_url}},
                    ],
                },
            ],
            response_format={"type": "json_object"},
        )

        if hasattr(response, "model_dump_json"):
            return response.model_dump_json()
        if hasattr(response, "model_dump"):
            return json.dumps(response.model_dump(), ensure_ascii=False)
        return str(response)


class AIService:
    def __init__(self, provider: AIProvider):
        self.provider = provider

    @classmethod
    def from_config(cls, config: dict) -> "AIService":
        mode = str(config.get("AI_MODE", "mock")).lower()
        if mode == "real":
            provider = DashScopeAIProvider(
                api_key=config.get("DASHSCOPE_API_KEY"),
                base_url=config.get(
                    "DASHSCOPE_BASE_URL",
                    "https://dashscope.aliyuncs.com/compatible-mode/v1",
                ),
                model=config.get("DASHSCOPE_MODEL", "qwen3.7-plus"),
            )
        else:
            provider = MockAIProvider()
        return cls(provider)

    def analyze(self, image_path: str, focus_hint: str | None = None) -> AIAnalysis:
        logger.info(
            "ai_analysis_start provider=%s image=%s focus_hint=%s",
            type(self.provider).__name__,
            Path(image_path).name,
            bool(focus_hint),
        )
        try:
            raw_response = self.provider.analyze(image_path, focus_hint=focus_hint)
        except Exception as exc:
            error_summary = sanitize_log_text(f"AI provider error: {exc}")
            logger.error(
                "ai_provider_error provider=%s error=%s",
                type(self.provider).__name__,
                error_summary,
            )
            return AIAnalysis(
                fields=empty_fields(),
                raw_response=error_summary,
                parse_error=error_summary,
            )

        try:
            fields = parse_ai_response(raw_response)
            logger.info(
                "ai_analysis_success provider=%s raw_len=%s subject=%s knowledge_point=%s",
                type(self.provider).__name__,
                len(raw_response or ""),
                fields.get("subject", ""),
                fields.get("knowledge_point", ""),
            )
            return AIAnalysis(fields=fields, raw_response=raw_response, parse_error=None)
        except Exception as exc:
            parse_error = sanitize_log_text(f"AI parse error: {exc}")
            logger.error(
                "ai_parse_error provider=%s raw_len=%s error=%s",
                type(self.provider).__name__,
                len(raw_response or ""),
                parse_error,
            )
            return AIAnalysis(
                fields=empty_fields(),
                raw_response=raw_response,
                parse_error=parse_error,
            )


def empty_fields() -> dict[str, str]:
    return {field: "" for field in REQUIRED_AI_FIELDS}


def sanitize_log_text(value: object) -> str:
    return SECRET_PATTERN.sub("sk-***", str(value))


def parse_ai_response(raw_response: str) -> dict[str, str]:
    payload = _loads_jsonish(raw_response)

    if isinstance(payload, dict) and all(field in payload for field in REQUIRED_AI_FIELDS):
        return _coerce_required_fields(payload)

    content = _extract_openai_content(payload)
    if content:
        nested_payload = _loads_jsonish(content)
        if isinstance(nested_payload, dict):
            return _coerce_required_fields(nested_payload)

    raise ValueError("response does not contain the required structured fields")


def _extract_openai_content(payload: object) -> str | None:
    if not isinstance(payload, dict):
        return None
    try:
        return payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return None


def _loads_jsonish(value: str | object) -> object:
    if not isinstance(value, str):
        return value

    text = value.strip()
    if not text:
        raise ValueError("empty response")

    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    elif not text.startswith("{"):
        bracketed = re.search(r"(\{.*\})", text, re.DOTALL)
        if bracketed:
            text = bracketed.group(1)

    return json.loads(text)


def _coerce_required_fields(payload: dict) -> dict[str, str]:
    missing = [field for field in REQUIRED_AI_FIELDS if field not in payload]
    if missing:
        raise ValueError(f"missing fields: {', '.join(missing)}")
    return {
        field: "" if payload[field] is None else str(payload[field]).strip()
        for field in REQUIRED_AI_FIELDS
    }
