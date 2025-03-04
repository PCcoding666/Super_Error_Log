/**
 * 超级错题本 - 主JavaScript文件
 */

// 在DOM加载完成后执行
document.addEventListener('DOMContentLoaded', function() {
    // 添加Bootstrap图标支持
    addBootstrapIcons();
    
    // 初始化工具提示
    initTooltips();
    
    // 处理移动端导航栏折叠
    handleMobileNav();
});

/**
 * 添加Bootstrap图标支持
 */
function addBootstrapIcons() {
    // 检查是否已加载Bootstrap图标
    if (!document.querySelector('link[href*="bootstrap-icons"]')) {
        const iconLink = document.createElement('link');
        iconLink.rel = 'stylesheet';
        iconLink.href = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.8.1/font/bootstrap-icons.css';
        document.head.appendChild(iconLink);
    }
    
    // 替换上传图标
    const uploadIcons = document.querySelectorAll('.upload-icon i');
    uploadIcons.forEach(icon => {
        if (icon.classList.contains('bi-cloud-arrow-up')) {
            icon.outerHTML = '<i class="bi bi-cloud-arrow-up"></i>';
        }
    });
}

/**
 * 初始化Bootstrap工具提示
 */
function initTooltips() {
    // 检查是否存在工具提示元素
    const tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'));
    if (tooltipTriggerList.length > 0) {
        tooltipTriggerList.map(function(tooltipTriggerEl) {
            return new bootstrap.Tooltip(tooltipTriggerEl);
        });
    }
}

/**
 * 处理移动端导航栏折叠
 */
function handleMobileNav() {
    const navbarToggler = document.querySelector('.navbar-toggler');
    const navbarCollapse = document.querySelector('.navbar-collapse');
    
    if (navbarToggler && navbarCollapse) {
        // 点击导航项后自动折叠导航栏
        const navItems = navbarCollapse.querySelectorAll('.nav-link');
        navItems.forEach(item => {
            item.addEventListener('click', function() {
                if (window.innerWidth < 992) {  // Bootstrap lg断点
                    navbarCollapse.classList.remove('show');
                }
            });
        });
    }
}

/**
 * 格式化日期时间
 * @param {string|Date} dateTime - 日期时间字符串或Date对象
 * @param {boolean} includeTime - 是否包含时间
 * @returns {string} 格式化后的日期时间字符串
 */
function formatDateTime(dateTime, includeTime = true) {
    if (!dateTime) return '';
    
    const date = typeof dateTime === 'string' ? new Date(dateTime) : dateTime;
    
    if (isNaN(date.getTime())) return dateTime;  // 如果无效日期则返回原值
    
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    
    if (!includeTime) {
        return `${year}-${month}-${day}`;
    }
    
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 截断文本
 * @param {string} text - 原始文本
 * @param {number} length - 最大长度
 * @returns {string} 截断后的文本
 */
function truncateText(text, length = 100) {
    if (!text) return '';
    if (text.length <= length) return text;
    return text.substring(0, length) + '...';
}

/**
 * 显示加载中动画
 * @param {HTMLElement} container - 容器元素
 * @param {string} message - 显示消息
 */
function showLoading(container, message = '加载中...') {
    container.innerHTML = `
        <div class="text-center py-5">
            <div class="spinner-border text-primary" role="status">
                <span class="visually-hidden">加载中...</span>
            </div>
            <p class="mt-3">${message}</p>
        </div>
    `;
}

/**
 * 显示错误消息
 * @param {HTMLElement} container - 容器元素
 * @param {string} message - 错误消息
 */
function showError(container, message = '发生错误，请重试') {
    container.innerHTML = `
        <div class="text-center py-5">
            <div class="text-danger">
                <i class="bi bi-exclamation-triangle-fill" style="font-size: 2rem;"></i>
            </div>
            <p class="mt-3 text-danger">${message}</p>
        </div>
    `;
}

/**
 * 显示空数据消息
 * @param {HTMLElement} container - 容器元素
 * @param {string} message - 显示消息
 */
function showEmptyData(container, message = '暂无数据') {
    container.innerHTML = `
        <div class="text-center py-5">
            <p>${message}</p>
        </div>
    `;
} 