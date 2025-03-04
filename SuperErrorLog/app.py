import os
import json
import time
from datetime import datetime
from flask import Flask, render_template, request, redirect, url_for, flash, jsonify, send_from_directory

from SuperErrorLog.config import (
    APP_NAME, APP_VERSION, HOST, PORT, 
    STATIC_FOLDER, TEMPLATES_FOLDER, 
    QWEN_API_KEY, DEEPSEEK_API_KEY,
    UPLOAD_FOLDER, ALLOWED_EXTENSIONS
)
from SuperErrorLog.database.models import ErrorLogDatabase
from SuperErrorLog.utils.image_utils import save_uploaded_image, get_image_path
from SuperErrorLog.utils.pipeline import pipeline_inference

# 创建Flask应用
app = Flask(__name__, 
            static_folder=STATIC_FOLDER,
            template_folder=TEMPLATES_FOLDER)

# 配置应用
app.secret_key = os.urandom(24)
app.config['MAX_CONTENT_LENGTH'] = 10 * 1024 * 1024  # 限制上传文件大小为10MB

# 初始化数据库
db = ErrorLogDatabase()

def allowed_file(filename):
    """检查文件扩展名是否允许"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@app.route('/')
def index():
    """首页"""
    return render_template('index.html', app_name=APP_NAME, app_version=APP_VERSION)

@app.route('/features')
def features():
    """功能特点页面"""
    return render_template('features.html', app_name=APP_NAME, app_version=APP_VERSION)

@app.route('/pricing')
def pricing():
    """价格方案页面"""
    return render_template('pricing.html', app_name=APP_NAME, app_version=APP_VERSION)

@app.route('/upload', methods=['GET', 'POST'])
def upload():
    """上传图片页面"""
    if request.method == 'POST':
        # 检查是否有文件
        if 'file' not in request.files:
            flash('没有选择文件', 'warning')
            return redirect(request.url)
        
        file = request.files['file']
        
        # 检查文件名是否为空
        if file.filename == '':
            flash('没有选择文件', 'warning')
            return redirect(request.url)
        
        # 检查文件类型是否允许
        if file and allowed_file(file.filename):
            # 保存临时文件
            temp_path = os.path.join(app.root_path, 'temp', f"{int(time.time())}_{file.filename}")
            os.makedirs(os.path.dirname(temp_path), exist_ok=True)
            file.save(temp_path)
            
            try:
                # 调用处理流程
                result = pipeline_inference(
                    image_path=temp_path,
                    qwen_api_key=QWEN_API_KEY,
                    deepseek_api_key=DEEPSEEK_API_KEY
                )
                
                # 保存图片到正式目录
                image_path = save_uploaded_image(temp_path)
                if not image_path:
                    raise Exception("保存图片失败")
                
                # 保存到数据库
                log_id = db.add_error_log(result, image_path)
                
                # 删除临时文件
                os.remove(temp_path)
                
                # 重定向到结果页面
                flash('题目分析成功！', 'success')
                return redirect(url_for('view_log', log_id=log_id))
                
            except Exception as e:
                flash(f'处理失败: {str(e)}', 'danger')
                # 删除临时文件
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                return redirect(request.url)
        else:
            flash('不支持的文件类型，请上传PNG、JPG、JPEG或WEBP格式的图片', 'warning')
            return redirect(request.url)
            
    return render_template('upload.html')

@app.route('/logs')
def logs():
    """历史记录页面"""
    # 获取所有错题记录
    error_logs = db.get_all_error_logs()
    
    # 获取所有一级标题（用于筛选）
    level_1_titles = db.get_all_titles(1)
    
    return render_template('logs.html', 
                          error_logs=error_logs, 
                          level_1_titles=level_1_titles)

@app.route('/logs/<int:log_id>')
def view_log(log_id):
    """查看单个错题记录"""
    # 获取错题记录
    log = db.get_error_log_by_id(log_id)
    
    if not log:
        flash('记录不存在', 'warning')
        return redirect(url_for('logs'))
    
    return render_template('view_log.html', log=log)

@app.route('/search')
def search():
    """搜索页面"""
    # 获取所有级别的标题（用于筛选）
    level_1_titles = db.get_all_titles(1)
    level_2_titles = db.get_all_titles(2)
    level_3_titles = db.get_all_titles(3)
    
    return render_template('search.html', 
                          level_1_titles=level_1_titles,
                          level_2_titles=level_2_titles,
                          level_3_titles=level_3_titles)

@app.route('/api/search', methods=['POST'])
def api_search():
    """搜索API"""
    data = request.json
    level = data.get('level', 1)
    title = data.get('title', '')
    
    # 搜索记录
    results = db.search_by_title(level, title)
    
    return jsonify(results)

@app.route('/static/<path:filename>')
def serve_static(filename):
    """提供静态文件"""
    return send_from_directory(app.static_folder, filename)

@app.route('/uploads/<path:filename>')
def serve_upload(filename):
    """提供上传的图片"""
    return send_from_directory(UPLOAD_FOLDER, filename)

# 错误处理
@app.errorhandler(404)
def page_not_found(e):
    return render_template('404.html'), 404

@app.errorhandler(500)
def server_error(e):
    return render_template('500.html'), 500

@app.template_filter('format_date')
def format_date(value):
    """格式化日期的模板过滤器"""
    if isinstance(value, str):
        try:
            value = datetime.strptime(value, '%Y-%m-%d %H:%M:%S')
        except ValueError:
            return value
    return value.strftime('%Y-%m-%d %H:%M:%S')

if __name__ == '__main__':
    # 确保必要的目录存在
    os.makedirs(os.path.join(app.root_path, 'temp'), exist_ok=True)
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    
    # 启动应用
    app.run(host=HOST, port=PORT, debug=True) 