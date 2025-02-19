# -*- coding: utf-8 -*-
import gradio as gr
import sys
import os

   # 获取当前脚本所在目录
current_dir = os.path.dirname(os.path.abspath(__file__))
   # 将 POC 目录添加到 Python 路径
sys.path.append(os.path.join(current_dir, '..'))  # 添加上级目录到路径
from POC.pipline import pipeline_inference

def process_image(image_path):
    """
    调用 pipeline_inference 函数，解析图片中的题目与学生答案，
    并与 DeepSeek 推理结果合并，最后将各字段返回以供前端展示。
    """
    if not image_path:
        return [""] * 7  # 若没上传图片，返回空字符串给前端的7个文本框

    try:
        result = pipeline_inference(image_path)
        # 根据你想展示的字段，从 result 中提取对应值
        question_val             = result.get("question", "")
        student_answer_val       = result.get("student_answer", "")
        solution_val            = result.get("solution", "")
        student_error_reason_val = result.get("student_error_reason", "")
        level_1_val             = result.get("level_1_title", "")
        level_2_val             = result.get("level_2_title", "")
        level_3_val             = result.get("level_3_title", "")

        return [
            question_val,
            student_answer_val,
            solution_val,
            student_error_reason_val,
            level_1_val,
            level_2_val,
            level_3_val
        ]
    except Exception as e:
        print(f"处理失败: {str(e)}")
        # 如果出错，同样返回7个空字段，或你也可在某个文本框中返回错误提示信息
        return [f"发生错误: {str(e)}"] + [""] * 6

with gr.Blocks() as demo:
    gr.Markdown("# Qwen + DeepSeek 一体化示例")
    gr.Markdown("上传一张图，自动获取`question`/`student_answer`并完成推理。")

    with gr.Row():
        image_input = gr.Image(
            type="filepath",
            label="上传题目图片"
        )

    # 分别对应我们要展示的几个字段
    question_text = gr.Textbox(label="Question")
    student_answer_text = gr.Textbox(label="Student Answer")
    solution_text = gr.Textbox(label="Solution")
    student_error_reason_text = gr.Textbox(label="Student Error Reason")
    level_1_title_text = gr.Textbox(label="Level 1 Title")
    level_2_title_text = gr.Textbox(label="Level 2 Title")
    level_3_title_text = gr.Textbox(label="Level 3 Title")

    submit_button = gr.Button("提交解析")

    # 当点击按钮时，会调用 process_image，
    # 将传入 image_input 的文件路径作为参数，
    # 并将函数返回的各字段显示到对应文本框中
    submit_button.click(
        fn=process_image,
        inputs=[image_input],
        outputs=[
            question_text,
            student_answer_text,
            solution_text,
            student_error_reason_text,
            level_1_title_text,
            level_2_title_text,
            level_3_title_text
        ]
    )

# 启动 Gradio
if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860, share=True)