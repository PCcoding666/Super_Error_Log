import gradio as gr
import os

from config.config_manager import ConfigManager
from services.vlm_service import VLMService
from utils.response_parser import ResponseParser


class GradioApp:
    """
    Gradio前端应用类
    """
    
    def __init__(self):
        """初始化Gradio应用"""
        self.config = ConfigManager()
        self.vlm_service = VLMService()
        
        # 创建Gradio界面
        self.app = self._create_interface()
    
    def _create_interface(self) -> gr.Blocks:
        """
        创建Gradio界面
        
        Returns:
            Gradio Blocks界面
        """
        with gr.Blocks() as app:
            gr.Markdown("## 题目解析")
            gr.Markdown("上传一张包含题目和学生解答的图片，系统将自动提取题目内容和学生答案。")
            gr.Markdown("支持的图片格式：JPG、JPEG、PNG、WEBP")

            with gr.Row():
                self.img_input = gr.Image(
                    type="filepath",
                    label="上传图片"
                )

            self.output_text = gr.JSON(label="解析结果")
            self.submit_button = gr.Button("提交解析")

            # 添加示例图片
            self._add_examples(self.img_input, self.output_text)

            # 绑定处理函数
            self.submit_button.click(
                fn=self.process_image, 
                inputs=[self.img_input], 
                outputs=[self.output_text]
            )
            
            return app
    
    def _add_examples(self, img_input, output_text):
        """
        添加示例图片
        
        Args:
            img_input: 图片输入组件
            output_text: 输出文本组件
        """
        example_path = os.path.join(
            self.config.get('temp_dir'),
            '测试示例.png'
        )
        
        if os.path.exists(example_path):
            gr.Examples(
                examples=[example_path],
                inputs=img_input,
                outputs=output_text,
                fn=self.process_image,
                cache_examples=True
            )
    
    def process_image(self, image=None):
        """
        处理上传的图片
        
        Args:
            image: 图片路径
            
        Returns:
            处理结果
        """
        if image is None:
            return {"error": "请上传图片"}
            
        try:
            # 使用VLM服务分析图像
            response = self.vlm_service.analyze_image(image)
            
            # 解析响应结果
            result = ResponseParser.parse_qwen_response(response)
            return result
            
        except Exception as e:
            return ResponseParser.format_error(e)
    
    def launch(self, **kwargs):
        """
        启动Gradio应用
        
        Args:
            **kwargs: 传递给gr.launch的参数
        """
        # 如果未提供参数，使用配置中的默认值
        if not kwargs:
            kwargs = {
                'server_name': self.config.get('server_host'),
                'server_port': self.config.get('server_port'),
                'share': self.config.get('share'),
                'show_error': True
            }
            
        return self.app.launch(**kwargs)


# 创建应用实例
demo = GradioApp().app

# 测试代码
if __name__ == "__main__":
    app = GradioApp()
    app.launch()
