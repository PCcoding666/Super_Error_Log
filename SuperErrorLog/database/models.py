import os
import json
import sqlite3
from datetime import datetime
from typing import List, Dict, Any, Optional

# 数据库文件路径
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'error_log.db')

# 确保数据目录存在
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

class ErrorLogDatabase:
    """错题本数据库管理类"""
    
    def __init__(self):
        """初始化数据库连接并创建表（如果不存在）"""
        self.conn = sqlite3.connect(DB_PATH)
        self.conn.row_factory = sqlite3.Row  # 使查询结果可以通过列名访问
        self.create_tables()
    
    def create_tables(self):
        """创建必要的数据库表"""
        cursor = self.conn.cursor()
        
        # 创建错题记录表
        cursor.execute('''
        CREATE TABLE IF NOT EXISTS error_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            question TEXT NOT NULL,
            student_answer TEXT,
            solution TEXT NOT NULL,
            student_error_reason TEXT NOT NULL,
            level_1_title TEXT NOT NULL,
            level_2_title TEXT NOT NULL,
            level_3_title TEXT NOT NULL,
            image_path TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        ''')
        
        self.conn.commit()
    
    def add_error_log(self, data: Dict[str, Any], image_path: str) -> int:
        """
        添加新的错题记录
        
        Args:
            data: 包含错题信息的字典
            image_path: 图片保存路径
            
        Returns:
            新记录的ID
        """
        cursor = self.conn.cursor()
        
        cursor.execute('''
        INSERT INTO error_logs 
        (question, student_answer, solution, student_error_reason, 
         level_1_title, level_2_title, level_3_title, image_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            data.get('question', ''),
            data.get('student_answer', ''),
            data.get('solution', ''),
            data.get('student_error_reason', ''),
            data.get('level_1_title', ''),
            data.get('level_2_title', ''),
            data.get('level_3_title', ''),
            image_path
        ))
        
        self.conn.commit()
        return cursor.lastrowid
    
    def get_error_log_by_id(self, log_id: int) -> Optional[Dict[str, Any]]:
        """根据ID获取错题记录"""
        cursor = self.conn.cursor()
        
        cursor.execute('SELECT * FROM error_logs WHERE id = ?', (log_id,))
        row = cursor.fetchone()
        
        if row:
            return dict(row)
        return None
    
    def get_all_error_logs(self) -> List[Dict[str, Any]]:
        """获取所有错题记录"""
        cursor = self.conn.cursor()
        
        cursor.execute('SELECT * FROM error_logs ORDER BY created_at DESC')
        rows = cursor.fetchall()
        
        return [dict(row) for row in rows]
    
    def search_by_title(self, level: int, title: str) -> List[Dict[str, Any]]:
        """
        根据标题级别和内容搜索错题记录
        
        Args:
            level: 标题级别 (1, 2, 3)
            title: 标题内容
            
        Returns:
            匹配的错题记录列表
        """
        cursor = self.conn.cursor()
        
        title_field = f"level_{level}_title"
        query = f"SELECT * FROM error_logs WHERE {title_field} LIKE ? ORDER BY created_at DESC"
        cursor.execute(query, (f"%{title}%",))
        
        rows = cursor.fetchall()
        return [dict(row) for row in rows]
    
    def get_all_titles(self, level: int) -> List[str]:
        """
        获取指定级别的所有标题（去重）
        
        Args:
            level: 标题级别 (1, 2, 3)
            
        Returns:
            标题列表
        """
        cursor = self.conn.cursor()
        
        title_field = f"level_{level}_title"
        query = f"SELECT DISTINCT {title_field} FROM error_logs ORDER BY {title_field}"
        cursor.execute(query)
        
        rows = cursor.fetchall()
        return [row[0] for row in rows]
    
    def close(self):
        """关闭数据库连接"""
        if self.conn:
            self.conn.close() 