#!/usr/bin/env python3
"""Refresh the standalone DDC workshop HTML from the packaged classroom plan."""

import argparse
import base64
import hashlib
import io
import json
import re
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZipFile

from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
SKILL = 'plugins/rdk-vision-workshop/skills/rdk-vision-workshop/assets'
PLAN = ROOT / SKILL / 'ddc-2026-12-06.json'
DESK = {
    'intro': (4, '写下观察区、改善目标和保护区。'),
    'connect': (6, '确认新帧和期初 ISP。'),
    'baseline': (8, '保存三张基线，每组启动一次训练。'),
    'formats': (9, '讲链路、图像侧分享，然后定观察区。'),
    'gamma_demo': (13, '同图区对照，核对回读与取舍。'),
    'gamma_trial': (14, '自己定目标，留第二轮的证据。'),
    'break': (15, '学员休息，助教核对原任务。'),
    'blind': (16, '先写偏好和理由，再翻看原记录。'),
    'reproduce': (16, '重载新帧与独立读回，助教预查产物。'),
    'deploy': (17, '按模型和相机画面选择本组检测、预置检测或观看演示。'),
    'deliver': (18, '恢复原始 ISP、停流、导出成果，再请代表分享。'),
}
TARGET_SAMPLE = ROOT / 'output/Studio-X5-本组模型-20261124/sample.png'
ISP_READBACK_CAPTURE = ROOT / 'output/camera-ai-workshop-1.5.0-studio/真机Gamma彩排/04-第1轮生成回读.png'


def closing_links(reference):
    import cv2
    import fitz
    import numpy as np

    destinations = {
        'forum.d-robotics.cc': '地瓜机器人开发者社区',
        'applink.feishu.cn': '飞书交流群',
        'horizonrobotics.feishu.cn': '地瓜机器人地心引力计划',
    }
    found = {}
    detector = cv2.QRCodeDetector()
    with fitz.open(reference) as pdf:
        page = pdf[-1]
        size = page.rect
        for left, right in ((.145, .300), (.425, .570), (.700, .850)):
            clip = fitz.Rect(size.width * left, size.height * .41, size.width * right, size.height * .65)
            for zoom in (1.5, 2.25, 1.0):
                image = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip, alpha=False)
                pixels = np.frombuffer(image.samples, dtype=np.uint8).reshape(image.height, image.width, 3)
                url, _, _ = detector.detectAndDecode(pixels)
                if url:
                    break
            address = urlsplit(url)
            if address.scheme != 'https' or address.netloc not in destinations:
                raise ValueError(f'Could not verify a reference QR code at column {left}')
            if address.netloc == 'forum.d-robotics.cc':
                url = 'https://developer.d-robotics.cc/'
            pattern = cv2.QRCodeEncoder_create().encode(url)
            code = cv2.resize(cv2.copyMakeBorder(pattern, 4, 4, 4, 4, cv2.BORDER_CONSTANT, value=255),
                              None, fx=10, fy=10, interpolation=cv2.INTER_NEAREST)
            if detector.detectAndDecode(code)[0] != url:
                raise ValueError(f'Could not verify the new QR code for {address.netloc}')
            ok, png = cv2.imencode('.png', code)
            if not ok:
                raise ValueError('Could not encode the QR image')
            found[address.netloc] = (url, base64.b64encode(png.tobytes()).decode())
    if found.keys() != destinations.keys():
        raise ValueError('Expected three distinct reference QR codes')
    return [(label, *found[host]) for host, label in destinations.items()]


def add_closing_page(get, tag, links):
    previous = get('#p18')
    page = tag('article', id='p19', **{'class': 'page deck-visual', 'data-n': '19'})
    header = tag('header', **{'class': 'ph'})
    header.append(tag('div', '课后交流', **{'class': 'kick'}))
    header.append(tag('h1', '谢谢参与，欢迎继续交流'))
    brand = previous.select_one('.brand')
    header.append(tag('img', alt='', src=brand['src'], **{'class': 'brand'}))
    page.append(header)
    body = tag('div', **{'class': 'pb'})
    grid = tag('div', **{'class': 'closing-qr'})
    for label, url, image in links:
        card = tag('section')
        enlarge = tag('button', type='button', **{'data-live-proof': '', 'aria-label': f'放大{label}二维码'})
        enlarge.append(tag('img', alt=f'{label}二维码', src='data:image/png;base64,' + image))
        card.append(enlarge)
        card.append(tag('h2', label))
        card.append(tag('a', '打开链接', href=url, target='_blank', rel='noopener noreferrer',
                        **{'aria-label': f'打开{label}链接'}))
        grid.append(card)
    body.append(grid)
    page.append(body)
    footer = tag('footer', **{'class': 'pf'})
    footer.append(tag('span', '视觉 Pipeline 工作坊'))
    footer.append(tag('span', '19 / 19', **{'class': 'no'}))
    page.append(footer)
    previous.insert_after(page)


def update_teaching_copy(soup, get, tag, links):
    checklist = get('#p5 .checks')
    checklist.select_one('li:nth-child(2)').decompose()
    checklist['data-checks'] = 'arrival-v2'
    checklist.select_one('[data-chip] b').string = '0 / 3'
    for i, item in enumerate(checklist.select('li'), 1):
        control = item.select_one('input')
        label = item.select_one('.tx')
        control['id'] = f'arrival-{i}'
        label.name = 'label'
        label['for'] = control['id']
    get('#p5 h1').string = '到场先做三项准备'
    notes = soup.select('#p5 > .note')
    for note, title, message in [
        (notes[0], '卡住怎么办', '相机没画面时请助教协助。进入检测时，如果本组模型还没出结果，就用预置模型或看演示。'),
        (notes[-1], '现场找谁', '主讲与控时 李茜 · Studio 与板卡支持 齐晓阳 · 图像讲解 刘尊辈、王天祥。'),
    ]:
        note.clear()
        note.append(tag('b', title))
        note.append(' ' + message)

    agenda = get('#p3 .mrg-agenda')
    agenda.select_one('li:last-child').decompose()
    agenda.select_one('li:last-child .h').string = '检测与带走成果'
    agenda.select_one('li:last-child .d').string = '按 A/B/C 跑检测，再恢复相机、导出成果并分享。'

    wrap = get('#p18 .pb')
    wrap.clear()
    get('#p18 h1').string = '恢复相机，带走成果'
    for page in (17, 18):
        get(f'#p{page} .kick').find(string=True, recursive=False).replace_with('环节八 · 检测与带走成果')
    for note in soup.select('#p18 > .note'):
        note.decompose()
    steps = tag('ol', **{'class': 'closing-steps'})
    for title, action, evidence in [
        ('恢复相机', '在 Studio 恢复原始 ISP，再停止采集。', '读回参数与原始记录一致，预览已停止。'),
        ('导出成果包', '下载 ZIP 并打开，找到两轮调参和 A/B/C 结果。', '前后图、读回记录、模型来源及待测项都能找到。'),
        ('分享一个发现', '请几组学员代表做简短分享。', '用一张前后对照图或检测结果，说清一次发现或取舍。'),
    ]:
        item = tag('li')
        item.append(tag('h2', title))
        item.append(tag('p', action))
        item.append(tag('small', evidence))
        steps.append(item)
    wrap.append(steps)
    action_bar = tag('div', **{'class': 'closing-actions'})
    for label, attrs in [
        ('查看实测证据', {'data-ws-open': 'evidence'}),
        ('打开助教验收要点', {'data-ws-open': 'cards', 'data-card': 'review'}),
    ]:
        action_bar.append(tag('button', label, type='button', **{'class': 'ws-control', **attrs}))
    wrap.append(action_bar)
    for page in (19, 20):
        get(f'#p{page}').decompose()
    add_closing_page(get, tag, links)
    for number, page in enumerate(soup.select('#stage > .page'), 1):
        footer = page.select_one('.pf')
        if footer:
            last = footer.find_all(recursive=False)[-1]
            last.string = f'{number} / 19'

    get('#ws-cards [data-card-select=prep]').string = '课前资料'
    todo = get('#ws-cards [data-sheet=prep] .todo-list')
    for item in todo.select('li'):
        if re.search('二维码|证书', item.get_text()):
            item.decompose()

    wording = {
        'Studio → 工位': 'Studio → 本组 X5',
        '开发机已连上，账号已领': '拿到小组训练账号，能登录开发机',
        '核对组号、板卡和已启用插件': '在 Studio 连接本组 X5，打开课堂工作台',
        'Studio 指向本组工位': 'Studio 显示 X5 已连接',
        '按工位号抽 3 名。': '现场抽出 3 名参与者。',
        '记状态，提前备好预置 INT8 和可用工位。': '看训练完成时间，准备预置 INT8。',
        '先按产物和工位走 A／B／C，再打开模型检测。': '按模型是否就绪和相机能否出图选择 A／B／C。',
        '按工位可用与本组 BIN 两个条件选路：A 本组模型上板，B 预置模型上板，C 记录观看演示。': '相机有画面时，有本组 BIN 走 A，只有预置 BIN 走 B。相机无画面或没有可用模型时，走 C 看演示。',
        '保存模型哈希、设备身份、新帧与检测日志。': '保存模型来源、现场画面和检测日志。',
        '保存本组模型哈希、设备身份、新帧及检测日志。': '保存本组模型的来源、现场画面和检测日志。',
        '实际工位怎么验收': '调完 Gamma，怎么确认生效？',
        '离线看图 → 返回工位': '离线看图 → 回到 Studio',
        '登录恢复了 · 回工位': '登录恢复了 · 回到 Studio',
        '先读工位可写范围': '先看相机允许调哪些参数',
        '读工位': '看可调参数',
        '读取本工位可写参数': '读取相机可调参数',
        '工位锁定的项跳过，不要硬改': '相机暂不支持调整的参数直接跳过',
        '11:45 依照可下发的模型和个人工位分流。选择各项条件，查看路径和要留的证据。': '看手上有哪份 INT8 模型、相机能否出图，选择操作路径。',
        '本人工位': '相机能出图吗？',
        '板卡与相机可用': '能出图',
        '暂不可用': '暂时无画面',
        '工位连接预检和原始 ISP': '相机预览和原始 ISP',
        '当前工位': '小组编号',
        '王天祥、志伟': '刘尊辈、王天祥',
        '能上板的组到工位；其余组跟助教看演示。': '相机能出图的组自己运行模型；其余组跟助教看演示。',
        'A 核对同 Run 的 INT8 和工位；B 核对预置来源和工位；C 记录演示来源与缺项。': 'A 记本组任务和 INT8，B 记预置模型来源，C 记看了哪段演示以及待完成内容。',
        '原件留在工位': '原件随本组成果包保存',
        '可复用的设备与备用工位须注明。': '',
        '历史入口参考 · RoboGO 单工位': '历史参考 · RoboGO 单组案例',
        '待核对 · 请先确认本人工位及本组模型状态。': '先选择相机是否出图，再选择本组模型是否就绪。',
        'C · 工位不可用。': 'C · 相机暂时没有画面。',
        '模型和工位在哪条路上汇合？': '手上的模型能上板做检测吗？',
        '先确认本组工位、课程数据和恢复起点。': '连接 X5，查看课程数据，保存原始 ISP。',
        '真实工位以可写色温或通道增益为准。': '实际可调项以相机显示的色温或通道增益为准。',
        '11:40 · 按当时的工位条件': '看模型和实时画面',
        '工位可用': '相机有画面',
        '工位不可用': '相机无画面',
        '工位状态': '相机画面',
        '保存本人工位的运行记录': '保存本组在 X5 上的检测结果',
    }
    for rich_text in soup.find_all(string=True):
        if not 0 < len(rich_text) < 1700 or rich_text.parent.name in ('script', 'style'):
            continue
        line = str(rich_text)
        for before, after in wording.items():
            line = line.replace(before, after)
        if line != rich_text:
            rich_text.replace_with(line)

    for script in soup.select('script'):
        code = script.string or ''
        if 'var PAGES = ' in code:
            match = re.search(r'^var PAGES = (.*);$', code, re.MULTILINE)
            pages = json.loads(match[1])[:18]
            pages[4]['title'] = '到场先做三项准备'
            pages[16]['sec'] = '环节八 · 检测与带走成果'
            pages[14]['title'] = '中场休息'
            pages[17].update(sec='环节八 · 检测与带走成果', title='恢复相机，带走成果')
            pages.append({'n': 19, 'sec': '课后交流', 'title': '谢谢参与，欢迎继续交流'})
            for page in pages:
                page.pop('dur', None)
            code = code[:match.start(1)] + json.dumps(pages, ensure_ascii=False) + code[match.end(1):]
            code = code.replace('if (ev.target === c) return;',
                                'if (ev.target === c || ev.target.closest("label")) return;')
        elif '#p19 .free' in code:
            script.decompose()
            continue
        elif 'const stations=Array.from' in code:
            code = code.replace('new Option(name,name)', 'new Option(\'第 \'+Number(name.slice(4))+\' 组\',name)')
            code = code.replace('label.textContent=name;', "label.textContent='第 '+Number(name.slice(4))+' 组';")
            code = code.replace('const record={station,', 'const group=Number(station.slice(4));\n   const record={group,')
            code = code.replace("a.download=station+'-离场验收.json'", "a.download='第 '+group+' 组-成果签收.json'")
        elif '#ws-route-result' in code or '11:40 · 按当时的工位条件' in code:
            for before, after in wording.items():
                code = code.replace(before, after)
        if code != (script.string or ''):
            script.string = code

    icons = {
        'toggle': ('打开或关闭目录', 'M4 6h16M4 12h16M4 18h16'),
        'prev': ('上一页', 'm14 6-6 6 6 6'),
        'next': ('下一页', 'm10 6 6 6-6 6'),
        'fs': ('切换全屏', 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5'),
    }
    for control, (label, path) in icons.items():
        button = get(f'#bar #{control}')
        button['aria-label'] = label
        svg = button.select_one('svg')
        svg['aria-hidden'] = 'true'
        if path:
            svg.path['d'] = path
    overview = get('#bar #ov')
    overview['aria-label'] = '总览'
    overview.svg['aria-hidden'] = 'true'
    overview.find(string=True, recursive=False).wrap(tag('span'))
    tools = get('#bar #workshop-tools')
    tools['aria-label'] = '课堂操作台'
    tools.string.wrap(tag('span', **{'class': 'toolbar-long'}))
    tools.append(tag('span', '操作台', **{'class': 'toolbar-short'}))


def remove_fixed_schedule(soup, get):
    for element in soup.select('#stage .kick em, #p3 .mrg-agenda .t, #p15 .cd, #bar .lbl, #bar #clock, #bar #timer, #bar #reset'):
        element.decompose()
    for selector, copy in {
        'title': '视觉 Pipeline 工作坊',
        '#p15 h1': '中场休息',
        '#p15 .ws-standard': '休息时，助教查看训练进度，提前准备预置 INT8。',
        '#tab-time': '课堂步骤',
        '#ws-time > p': '从连接设备到带走成果。点击「进入课件」打开对应步骤。',
        '#ws-route > p': '看手上有哪份 INT8 模型、相机能否出图，选择操作路径。',
        '#ws-cards [data-sheet=expert] h3': '从曝光接到两轮 Gamma',
        '#ws-cards [data-sheet=prep] > p:first-of-type': '安装 Studio 和课堂插件，确认可以打开课堂工作台。',
        '#ws-cards [data-sheet=prep] > p:nth-of-type(2)': '解压插件 ZIP，在 Studio 打开 AI → 扩展中心 → 从目录导入插件。看到 RDK Camera AI 已启用后，打开课堂工作台。',
        '#ws-ops > p:last-of-type': '助教跟踪原任务的日志和产物，记录训练、导出和量化各阶段的实测耗时。进入检测时，本组模型还未就绪的学员按预置模型或讲师演示完成。',
        '#film-0 figcaption p': '看学员怎样找到当前一步、打开相机预览并保存原始 ISP。录屏供操作参考。',
    }.items():
        get(selector).string = copy

    wording = {
        '全程 180 分钟，含 10 分钟中场休息。左侧目录可直接跳页。':
            '按步骤完成课堂任务。点击左侧目录可以跳到对应页面。',
        '入场自检 · 09:20–09:30': '入场准备',
        '存三种基线；10:10 每组启动一次训练': '保存三种基线，每组启动一次训练',
        '10:15–10:25 本课开场与链路六格 · 10:25–10:35 图像侧分享 10 分钟 · 10:35–10:40 确定观察区':
            '理解成像链路，听图像专家讲解，然后选定观察区',
        '11:30 助教预查；11:45 取结果，照就绪状态分流。': '用同一个任务编号查看进度，进入检测时按模型是否就绪分流。',
        '11:45 用已就绪的预置 INT8，或观看实录。': '进入检测时使用预置 INT8，或观看实录。',
        '10:15–10:25 课程引导 · 滑到不同处理步，观察同一块区域变化。': '滑到不同处理步，观察同一块区域的变化。',
        '10:25–10:35 图像侧分享。': '图像专家分享。',
        '请一组示范。10:35–10:40 固定机位和基线；': '请一组示范。固定相机位置和基线。',
        '时长若明显长于云端估算，11:45 未就绪的组转 B 或 C，后续独立时段照常。':
            '进入检测时，本组模型还未就绪的组走 B 或 C。',
        '归档 1.5.0 已做 Studio 右侧和 X5 两轮 Gamma。': '已留存 Studio 右侧工作台和 X5 两轮 Gamma 的操作记录。',
        '冻结版 Studio · 待彩排': '全流程 · 待现场彩排',
        '版本 1.5.9-rc.3。核对工具调用及右侧课页。': '核对工具调用及右侧课堂工作台。',
        '冻结版 1.5.0 · Gamma 实机': 'Gamma 真机实操',
        '1.5.9-rc.6。两段各 25 秒': '两段各 25 秒',
        ' · 1.5.9-rc.1': '',
        ' · 1.5.9-rc.6': '',
    }
    for element in soup.select('#ws-media figcaption strong, #ws-cards .talk-step summary'):
        clean = re.sub(r'^\d{2}:\d{2}(?:[–—]\d{2}:\d{2})?[\s·]+', '', element.get_text(strip=True))
        element.string = clean
    for text in soup.find_all(string=True):
        if len(text) > 500 or text.parent.name in ('style', 'script'):
            continue
        copy = str(text)
        for before, after in wording.items():
            copy = copy.replace(before, after)
        if copy != text:
            text.replace_with(copy)

    get('#ws-cards a[download$=".pdf"]')['download'] = 'RDK-Camera-AI-学员图文指南.pdf'
    for element in soup.select('#ws-evidence [aria-label*="冻结版"], #ws-evidence img[alt*="冻结版"]'):
        key = 'alt' if element.name == 'img' else 'aria-label'
        element[key] = element[key].replace('冻结版 1.5.0 Gamma', 'Gamma')

    for script in soup.select('script'):
        code = script.string or ''
        if 'function toggleTimer()' in code:
            code = re.sub(r'/\* =+ 计时 =+ \*/.*?(?=/\* =+ 图片)', '', code, flags=re.S)
            code = re.sub(r'/\* =+ 中场休息倒计时 =+ \*/.*?(?=/\* =+ 轮转表)', '', code, flags=re.S)
            code = re.sub(r"^.*document\.getElementById\('(timer|reset)'\)\.onclick.*\n", '', code, flags=re.M)
            code = code.replace("  else if (k === 't'){ toggleTimer(); } else if (k === 'r'){ resetTimer(); }\n", '')
            code = re.sub(r'\npaint\(\);\s*\Z', '\n', code)
            code = code.replace("    if (!on && s._stop) s._stop();\n", '')
            code = code.replace("    (PAGES[n - 1].dur ? '（' + PAGES[n - 1].dur + '）' : '') + ", "    ")
            script.string = code
        elif "const moments=['09:45'" in code:
            code = code.replace(
                "const moments=['09:45','10:15','10:35','11:30','11:45','12:10'];",
                "const moments=['连接相机','启动训练','等待时调参','查看进度','检测分流','恢复与导出'];",
            )
            script.string = code.replace('课堂时钟', '课堂进度').replace('同一时钟 · 两条任务线', '相机和训练并行')


def make_instructor_deck(soup, get, tag):
    for node in soup.select('#stage .checks input, #stage .checks [data-chip], #p12 .defs .bar, [data-wf-no-terms]'):
        node.decompose()
    for node in soup.select('#p5 .checks label'):
        node.name = 'span'
        del node['for']
    for node in soup.select('#stage .checks'):
        del node['data-checks']

    panel = get('#ws-gamma')
    rounds = tag('div', **{'class': 'ws-switch gamma-rounds', 'role': 'group', 'aria-label': 'Gamma 演示轮次'})
    for number, label in [('1', '第 1 轮 · 跟做'), ('2', '第 2 轮 · 自主选区')]:
        rounds.append(tag('button', label, type='button', **{'data-ws-round': number, 'aria-pressed': str(number == '1').lower()}))
    panel.select_one('.workshop-preview').insert_before(rounds)
    get('#p13 [data-ws-open=gamma1]').string = '演示第 1 轮 Gamma'
    second = get('#p14 [data-ws-open=learner]')
    second['data-ws-open'] = 'gamma2'
    second.string = '演示第 2 轮 Gamma'
    get('#ws-gamma .ws-decision > label').decompose()
    get('[data-ws-decision=keep]').string = '保留示例效果'
    get('[data-ws-decision=restore]').string = '恢复示例基线'
    handoff = get('#login-handoff')
    paragraphs = handoff.select('p')
    paragraphs[0].string = '拖动指数和分界线，先看暗部笔画，再看高光。请学员口头说出保留或恢复的理由。'
    paragraphs[2].string = '在 Studio 对话中请 RDK Camera AI 打开课堂工作台。如果右侧打不开，且工具已返回本机链接，可以复制完整链接到同一台电脑的浏览器。'

    review = get('#ws-cards [data-sheet=review]')
    review.clear()
    review.append(tag('h3', '两轮 Gamma 验收要点'))
    overview = tag('div', **{'class': 'instructor-review'})
    for title, bullets in [
        ('第 1 轮 · 跟做', ('同一相机位置和光照下，能指出暗部笔画与右上高光。',
                             '查看调前、调后两张新实拍和 Gamma 独立回读。',
                             '问学员为何保留或恢复。选择恢复时，核对恢复后的回读。')),
        ('第 2 轮 · 自主选区', ('能指出一个要改善的区域，以及一个要保护的区域。',
                                 '只改一项，用本轮的前后图和独立回读说明变化。',
                                 '查阅 Studio 成果包里的本轮原件和取舍结果。')),
    ]:
        card = tag('section')
        card.append(tag('h4', title))
        items = tag('ul')
        for bullet in bullets:
            items.append(tag('li', bullet))
        card.append(items)
        overview.append(card)
    review.append(overview)
    review.append(tag('p', '结束检测后，核对恢复后的参数、停流结果、模型来源与待测项。'))
    get('[data-card-select=review]').string = '两轮验收要点'
    fallback = get('#manual-copy label')
    fallback.replace_with(tag('p', '选择下方文字后复制'))
    get('#manual-copy form').insert_before(tag('pre', id='manual-copy-text', tabindex='0'))

    for script in soup.select('script'):
        code = script.string or ''
        if 'const form=document.getElementById(\'round-form\')' in code:
            script.string = """(() => {
 function showSheet(id) {
   for (const section of document.querySelectorAll('[data-sheet]')) section.hidden = section.dataset.sheet !== id;
   for (const control of document.querySelectorAll('[data-card-select]')) {
     control.setAttribute('aria-pressed', String(control.dataset.cardSelect === id));
   }
 }
 document.addEventListener('click', event => {
   const button = event.target.closest('button');
   if (!button) return;
   if (button.dataset.wsOpen || button.dataset.wsTab) {
     document.getElementById('login-handoff').hidden = !button.hasAttribute('data-login-lesson');
   }
   const sheet = button.dataset.cardSelect || button.dataset.card;
   if (sheet) showSheet(sheet);
   if (button.dataset.filmOpen) document.querySelector('[data-film="' + button.dataset.filmOpen + '"]')?.click();
 });
 showSheet('expert');
})();"""
        elif 'const explanation = modal.querySelector' in code:
            code = '\n'.join(line for line in code.splitlines() if 'explanation' not in line)
            code = code.replace('const saved = LD("ws-example-v1", {});', 'const saved = {};')
            code = code.replace('    SV("ws-example-v1", saved);\n', '')
            code = code.replace('    saved[selected] = {choice, candidate, current: range.value, split: split.value, reason};',
                                '    saved[selected] = {choice, candidate, current: range.value, split: split.value};')
            code = code.replace('  function updateSample() {\n  }', '''  function updateSample() {
    const item = saved[selected] || {};
    const decision = item.current === range.value ? item : {};
    saved[selected] = {...decision, current: range.value, split: split.value};
    displayDecision();
  }''')
            code = code.replace('"已在本机保存示例取舍：" + (item.choice === "keep" ? "保留" : "恢复") + "。原候选 " + item.candidate + "。"',
                                '(item.choice === "keep" ? "当前保留示例效果，指数 " : "已恢复示例基线 1.00，原候选指数 ") + item.candidate + "。"')
            code = code.replace('先拖动指数观察变化，再填写取舍理由。', '先拖动指数观察变化，再比较保留候选和恢复基线。')
            code = code.replace('观察区为整张标准测试卡。看中间调是否自然，检查暗部细节与右上高光是否还能辨认。',
                                '在暗部笔画或整体明暗中选一个观察目标，同时指定一个需要保护的区域。')
            code = code.replace('待核对 · 请先确认相机能出图吗？及本组模型状态。', '先选择相机是否出图与本组模型是否就绪。')
            script.string = code
        elif 'var PAGES = ' in code:
            code = re.sub(r'/\* =+ 术语检索 =+ \*/.*?(?=/\* =+ 链路联动)', '', code, flags=re.S)
            code = code.replace("const field=dialog.querySelector('textarea'); field.value=s; dialog.showModal(); field.focus(); field.select();",
                                "const field=dialog.querySelector('pre'); field.textContent=s; dialog.showModal(); field.focus(); const range=document.createRange(); range.selectNodeContents(field); const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range);")
            script.string = code
        elif 'document.querySelectorAll("[data-wf-no-terms]")' in code:
            script.string = re.sub(r'  document.querySelectorAll\("\[data-wf-no-terms\]"\).*?\n  \}\);\n', '', code, flags=re.S)


def polish_instructor_pages(soup, get, tag):
    headings = {
        1: '课前装好软件，拿到训练入口',
        4: '今天要完成什么？',
        5: '开始前，确认这组能做什么',
        11: 'Gamma 之外，还能调什么？',
        16: '保存调校配置，重新加载验证',
        17: '用 INT8 模型在 X5 上检测',
    }
    for page, title in headings.items():
        get(f'#p{page} h1').string = title

    copies = {
        '#p1 .ph .sub': '课件提供两个软件下载入口，训练账号由助教发放。',
        '#p4 .effect-demo strong': '先看同一张测试卡的曝光对照',
        '#p4 .effect-demo small': '浏览器模拟。先看亮部是否丢失纹理，再用真机示例解释原因。',
        '#p8 [data-ws-open=ops]': '查看训练准备事项',
        '#p8 [data-ws-open=evidence]': '看历史训练示例',
        '#p9 .ph .sub': '先分清光怎样变成图像，再看各个 ISP 模块分别处理什么。',
        '#p11 .mrg-cue': '同一张测试卡演示五种参数。后面两轮用 Gamma 练习这套观察与验收方法。',
        '#p14 .vd-foot': '先确定要改善和要保护的区域。调完在 Studio 查看前后图和参数回读，再决定保留或恢复。',
        '#p16 .workshop-action-cue p:first-child span': '在 Studio 重新加载选好的 ISP 配置。',
        '#p16 .workshop-action-cue p:last-child span': '新画面持续更新，重新读取的参数与保存的值一致。',
    }
    for selector, copy in copies.items():
        get(selector).string = copy
    historical = get('#p8 [data-ws-open=evidence]')
    historical['data-ws-open'] = 'media'
    historical['data-film-open'] = '4'

    prepare = get('#p5 .pb')
    prepare.clear()
    cards = tag('div', **{'class': 'launch-grid arrival-options'})
    for title, action, success in [
        ('打开 Studio', '登录后打开课堂工作台。', '右侧能看到本组的课堂进度。'),
        ('连接本组 X5', '打开预览，把测试卡从镜头前移过。', '画面随场景变化。没有画面请找助教。'),
        ('确认训练入口', '用助教发的账号登录开发机。', '账号暂未就绪时，先做相机与 ISP。'),
    ]:
        card = tag('section')
        card.append(tag('h2', title))
        card.append(tag('p', action))
        card.append(tag('small', success))
        cards.append(card)
    prepare.append(cards)
    get('#p5 > .note').decompose()

    for page, titles, bodies, note, image_note in [
        (16, ('先选图', '保存并加载', '确认可以恢复'),
         ('先比较两张图，选更符合目标的一张，再揭晓它用的配置。',
          '保存选好的配置。重新加载后，再读参数并采一张新图。',
          '确认原始 ISP 配置已保留，收尾时用它恢复。'),
         None, '点图放大，查看调参前后图和参数读值。'),
        (17, ('选择路径', '加载模型', '看两个结果'),
         ('A 用本组模型，B 用预置模型，C 看讲师演示。',
          'A、B 在 X5 加载 INT8 BIN，记录模型来源与文件哈希。',
          '先看新帧和推理结果，再看课程目标有没有连续检出。'),
         ('杯子场景的采流和推理。', '课程目标的连续检出。'),
         '点图放大，查看实时画面与检测结果。'),
    ]:
        slide = get(f'#p{page}')
        for item, title, body in zip(slide.select('.proof-tasks li'), titles, bodies):
            item.b.string = title
            item.span.string = body
        if note:
            status = slide.select_one('.proof-standard')
            status.clear()
            status.append(tag('b', '已测'))
            status.append(' ' + note[0])
            status.append(tag('br'))
            status.append(tag('b', '待测'))
            status.append(' ' + note[1])
        else:
            slide.select_one('.proof-standard').decompose()
        caption = slide.select_one('figcaption')
        caption.find_all(string=True, recursive=False)[-1].replace_with(image_note)
    get('#p17 > .note').decompose()
    get('#p17 .workshop-action-cue').decompose()
    if ISP_READBACK_CAPTURE.is_file():
        studio_capture = get('#p16 [data-live-proof] img')
        studio_capture['src'] = 'data:image/png;base64,' + base64.b64encode(ISP_READBACK_CAPTURE.read_bytes()).decode()
        studio_capture['alt'] = 'Studio 真机 Gamma 调前和调后画面，以及两次参数读回'
        studio_capture.parent['aria-label'] = '放大 Studio 真机前后对照和参数读回'

    pipeline = tag('div', **{'class': 'short-pipeline', 'role': 'group', 'aria-label': '从训练到板端模型'})
    steps = tag('ol')
    for item in ('训练权重', '导出 ONNX', 'PTQ 量化', '编译为 X5 INT8 BIN'):
        steps.append(tag('li', item))
    pipeline.append(steps)
    pipeline.append(tag('button', '看量化短片', type='button', **{
        'class': 'ws-control compact-control', 'data-ws-open': 'media', 'data-film-open': '3',
    }))
    get('#p17 .verified-slide').insert_before(pipeline)

    wording = {
        '选定版本，重载验一次': headings[16],
        '相机服务、板卡连接、新帧与期初 ISP': '连上 X5，看到实时画面并保存原始 ISP',
        '盲选、保存、重载并核对新图与回读': '选出效果更好的图，重载配置并再次读取参数',
        '选择已适配模式，打开实时预览': '选择本组相机，打开实时预览',
        '原始 ISP + 新图': '原始 ISP 配置与基线图',
        'Bayer RAW／ISP 显示图／渲染图，同一标准案例的合成示意；调参前后用同一类图比较。':
            'Bayer RAW 是传感器原始读数，ISP 显示图用于比较调参效果，渲染图用于讲解处理过程。',
        '未拿到连接卡': '训练入口暂未就绪',
        '打开开发机连接卡': '查看训练准备事项',
        '模型吃 NV12。同一份 ISP 输出，两种消费者。': '模型按本课要求接收 NV12 图像。',
        'sensor 感光': '传感器感光',
        '左：RAW 只有明暗': '左：Bayer RAW 以灰度显示',
        '每个像素只记一种颜色': '每个像素只测一种滤色片下的光强',
        '颜色靠邻域推算，不是记录下来': '去马赛克用邻近像素补出缺失的颜色通道',
        '；缺的两个通道靠邻域推算，信息量没有增加。': '。去马赛克用邻近像素估算缺失的两个通道。',
        '+0.8 EV': '延长曝光',
        '2.25×': '提高增益',
        '1.60×': '拉开明暗',
        '偏暖 26': '偏暖示例',
        '高光先看饱和。曝光更长也更容易拍糊。': '亮处可能过曝，运动物体也更容易拖影。',
        '暗部更亮，噪点也更显眼。曝光时间固定。': '曝光时间不变时，提高增益可提亮暗部，噪点也可能更明显。',
        '看两端是否压成一片。从中灰拉开明暗。': '明暗反差增大时，检查暗部和高光的层次是否还在。',
        '看边缘和光晕。增强边缘会带来光晕。': '边缘更清楚了，也要看看轮廓是否多出一圈亮边。',
        '暗部被提亮的同时，噪点也一起被放大——这就是取舍。': '提亮暗部后，原有噪点也可能更显眼。',
        '按规定 IoU 阈值把各类检测精度汇总成一个指标。推理跑通不等于目标检出。':
            '先按规定的重叠阈值算出各类别的平均精度（AP），再对各类别取平均。',
        '离座前确认设备仍运行。': '训练留在后台运行，休息后查看原任务进度。',
        '回来做盲选、导出和重载。': '回来先比较效果，再保存配置并重新加载。',
        '适用版本与证据范围以图注为准。': '每张图的图注说明它验证了什么。',
        '杯子场景仅作负对照；背景也可能出框。': '杯子场景用于验证实时采流和推理，背景也可能出现检测框。',
        '数值写不进去就报组号，改用预置版本把这一轮走完。': '写入失败时请助教排查，并保留本轮未完成的记录。',
        '选定版本': '选定配置',
    }
    for text_node in soup.find_all(string=True):
        if not 0 < len(text_node) < 700 or text_node.parent.name in ('script', 'style'):
            continue
        text = str(text_node)
        for before, after in wording.items():
            text = text.replace(before, after)
        if text != text_node:
            text_node.replace_with(text)
    for element in get('#p11 .mrg-five').select('.h'):
        for text_node in element.find_all(string=True):
            if text_node.strip() == '1.95':
                text_node.replace_with('强调边缘')

    nav = next(node for node in soup.select('script') if 'var PAGES = ' in (node.string or ''))
    match = re.search(r'^var PAGES = (.*);$', nav.string, re.MULTILINE)
    entries = json.loads(match[1])
    nav_titles = {1: '安装软件，确认训练入口', 16: '保存并加载 ISP 配置'}
    for page, title in headings.items():
        entries[page - 1]['title'] = nav_titles.get(page, title)
    nav.string = nav.string[:match.start(1)] + json.dumps(entries, ensure_ascii=False) + nav.string[match.end(1):]


def add_instructor_handoff(soup, get, tag):
    handoff = get('#p11 .note5')
    enlarge = handoff.select_one('[data-ws-open=isp]').extract()
    enlarge.string = '放大五组对照'
    handoff.clear()
    handoff['class'].append('gamma-handoff')
    handoff.append(tag('h2', '动手前，问全场'))
    handoff.append(tag('p', '「你想让哪里更清楚？又想保住哪里？」', **{'class': 'handoff-question'}))
    handoff.append(tag('p', '请一组先回答，再指着标准图确认暗部笔画和高光阶梯。'))
    buttons = tag('div', **{'class': 'handoff-actions'})
    buttons.append(tag('button', '进入第 1 轮', type='button', **{
        'class': 'ws-control compact-control', 'data-course-jump': '13',
    }))
    buttons.append(enlarge)
    handoff.append(buttons)

    get('#p13 .vd-foot span').string = (
        '先在示例里指出暗部笔画和高光阶梯，然后在 Studio 固定相机与光照，只调 Gamma。'
        '看前后新图和实际读值，再决定保留或恢复。'
    )
    get('#cue-2 > p:first-of-type').string = (
        '“你想让哪里更清楚？又想保住哪里？请一组说给大家听。'
        '现在指给我看这两处。相机和光照先固定，我们只改 Gamma。”'
    )
    get('#p4 .proof-short button').string = '看 X5 上板证据'
    get('#p4 .proof-short span').string = '先看相机实时画面，再看课程目标的静态检测结果。'

    opening = get('#ws-evidence')
    opening.insert(0, tag('p', '相机实时画面用来确认采流和推理。另看静态路锥样张的检测框，了解课程目标的预期效果。',
                          **{'class': 'ws-brief opening-evidence'}))
    gallery = opening.select_one('.checked-gallery')
    frames = {figure.figcaption.b.get_text(strip=True): figure for figure in gallery.select('figure')}
    for title in ('X5 BPU · 静态路锥已检出', 'X5 BPU · 相机实时新帧'):
        gallery.insert(0, frames[title].extract())
    ending = get('#p18 .closing-steps li:last-child p')
    ending.string = '请学员代表先指给大家看一张图，再说清结果。'
    get('#p18 .closing-steps li:last-child small').string = '哪里想改善？改了什么？用哪条证据决定保留、恢复或换检测路径？'

    script = tag('script')
    script.string = """document.querySelectorAll('[data-course-jump]').forEach(button => {
  button.addEventListener('click', () => {
    const page = Number(button.dataset.courseJump);
    go(page);
    const heading = document.querySelector('#p' + page + ' h1');
    heading.tabIndex = -1;
    heading.focus({preventScroll:true});
  });
});"""
    soup.body.append(script)


def use_course_images(soup, get, tag):
    from PIL import Image

    sample_status = '推荐路线：用同一张课程示例图练习两轮调参和前后对比。'
    base_capture = ROOT / 'output/camera-ai-workshop-1.5.0-studio/真机Gamma彩排/第1轮-调前.png'
    static_result = TARGET_SAMPLE.with_name('static.jpg')
    for selector, copy in {
        '#p4 .proof-short button': '看基线采集和样张检测',
        '#p4 .proof-short span': '相机实拍用于点亮与基线采集，调参用课程示例图。',
        '#p4 .effect-demo small': '课程示例图。先看亮部纹理有没有丢失，再看暗部是否变化。',
        '#p6 h1': '点亮相机，采集并保存基线',
        '#p13 .vd-foot span': '先在课程示例图指出暗部笔画和高光阶梯，只改 Gamma。对比前后效果，再决定保留还是恢复示例基线。',
        '#p14 .vd-foot': '沿用同一张示例图，自选观察区与保护区。用前后对比说清为什么保留或恢复。',
        '#p16 h1': '用同一张示例图复现调参',
        '#p17 h1': '把课程示例图送进 X5 检测',
        '#p18 .closing-steps li:first-child h2': '确认采集已结束',
        '#p18 .closing-steps li:first-child p': '基线采集完成后，确认相机预览已停止。',
        '#p18 .closing-steps li:first-child small': '做过实拍调参拓展的组，先恢复原始 ISP、读回确认，再停流。',
        '#p18 .closing-steps li:nth-child(2) h2': '整理课堂成果',
        '#p18 .closing-steps li:nth-child(2) p': '保存相机基线图、两轮示例对照截图和检测路径。',
        '#p18 .closing-steps li:nth-child(2) small': '留好示例参数与取舍理由。A、B 另留模型来源和检测结果。',
        '#ws-gamma > p:first-child': sample_status + '这里显示的是浏览器示例指数。',
        '#ws-gamma .mrg-open b': '两轮示例图，验收看什么？',
        '#ws-gamma .mrg-open p': '同一张图只改一项。对比观察区与保护区，说出前后变化、示例参数以及保留或恢复的理由。',
        '#ws-route > p': '根据手上的 INT8 模型和板端推理状态，选择课程样张的检测路径。',
        '#ws-cards [data-sheet=evidence] > p': '已用本组 INT8 在 X5 上检测固定课程样张。现场按模型来源和板端是否可运行选择路径。',
        '#ws-cards [data-sheet=review] > p': '用课程图完成即可。实拍调参是拓展，额外留参数回读与恢复记录。',
        '#cue-2 > p:first-of-type': '“你想让哪里更清楚？又想保住哪里？请一组指给大家看这两处。我们用同一张课程图，只改 Gamma。”',
        '#cue-4 > p:first-of-type': '“A 用本组 INT8，B 用预置 INT8。两组都用同一张课程样张。手上没有可用模型或板卡时，跟着我看示例。”',
        '#cue-5 > p:first-of-type': '“请指给大家看同一张图的两种效果，说清用了哪个参数、最后为什么保留或恢复。”',
    }.items():
        get(selector).string = copy

    for selector, copy in {
        '#p4 .mrg-four > div:nth-child(1) span': '看实时画面，留一张基线图',
        '#p4 .mrg-four > div:nth-child(2) span': '用同一张课程图，对比两轮 Gamma',
        '#p4 .mrg-four > div:nth-child(3) span': '用固定样张看检测框和标签',
        '#p4 .mrg-four > div:nth-child(4) span': '留基线、示例对照和检测结果',
        '#p6 .stp:last-child .sl:nth-child(2) span': '保存原始 ISP，采一张基线图。',
        '#p6 .stp:last-child .sl:nth-child(3) span': '基线图已保存，原始配置可以找到。',
        '#p6 .stp:last-child .sl:nth-child(4) span': '停止预览，下一步打开课程示例图。',
    }.items():
        get(selector).string = copy

    for page, steps in {
        16: [('先选图', '先看两种效果，选更符合目标的一张。'),
             ('再做一次', '在同一张课程图上回到基线，再输入选中的 Gamma 指数。'),
             ('说出判断', '对比暗部笔画和高光阶梯，说明为什么保留或恢复。')],
        17: [('选择路径', 'A 用本组 INT8，B 用预置 INT8，C 看讲师演示。'),
             ('用固定样张检测', 'A、B 在 X5 处理同一张课程样张，记下模型来源。'),
             ('对照示例结果', '查看检测框的位置、类别和置信度。')],
    }.items():
        for element, (title, copy) in zip(get(f'#p{page} .proof-tasks ol').select('li'), steps):
            element.b.string = title
            element.span.string = copy

    replay = get('#p16 .verified-slide')
    replay['class'] = ['example-replay']
    figure = replay.select_one('figure').extract()
    replay.insert(0, figure)
    figure.clear()
    figure['class'] = ['replay-compare']
    pair = tag('div', **{'class': 'replay-pair'})
    for title, value in [('基线', '1.00'), ('候选', '0.80')]:
        card = tag('div', **{'class': 'replay-picture'})
        heading = tag('div', **{'class': 'replay-label'})
        heading.append(tag('b', title))
        heading.append(tag('span', f'Gamma {value}'))
        card.append(heading)
        card.append(tag('canvas', width='840', height='264', **{
            'role': 'img', 'aria-label': f'课程示例图，{title} Gamma {value}', 'data-replay-gamma': value,
        }))
        pair.append(card)
    figure.append(pair)
    figure.append(tag('figcaption', '同一张图，重点对比暗部笔画和亮部阶梯。'))
    tasks = replay.select_one('.proof-tasks')
    tasks.select_one('.workshop-action-cue').decompose()
    actions = tag('div', **{'class': 'replay-actions'})
    actions.append(tag('p', '验收看：重新输入同一个值，暗部和高光是否重现同样的变化。'))
    actions.append(tag('button', '打开 Gamma 示例复现', type='button',
                       **{'class': 'ws-control', 'data-ws-open': 'gamma2'}))
    tasks.append(actions)
    status = get('#p17 .proof-standard')
    status.string = '已验证：本组 INT8 在 X5 上对固定课程样张出框。'

    def image_card(figure, path, label, caption):
        figure.clear()
        content = path.read_bytes()
        if path.suffix == '.png':
            # Keep the original capture as evidence, with a smaller copy for projection.
            with Image.open(io.BytesIO(content)) as original:
                preview = original.convert('RGB')
                preview.thumbnail((1280, 800))
                image_data = io.BytesIO()
                preview.save(image_data, format='JPEG', quality=90)
                content = image_data.getvalue()
        image = tag('img', alt=label, src='data:image/jpeg;base64,' + base64.b64encode(content).decode())
        enlarge = tag('button', type='button', **{
            'class': 'slide-proof', 'data-live-proof': '', 'aria-label': f'放大{label}',
        })
        enlarge.append(image)
        figure.append(enlarge)
        figure.append(tag('figcaption', caption))

    image_card(get('#p17 figure'), static_result, '课程样张的 X5 静态检测结果',
               '真实 X5 输出 · 固定课程样张。点图可放大查看类别和置信度。')
    get('#p17 figure').append(tag('a', '下载课程检测样张',
                                  href='data:image/png;base64,' + base64.b64encode(TARGET_SAMPLE.read_bytes()).decode(),
                                  download='课程检测样张.png', **{'class': 'ws-control sample-download'}))

    board = get('#ws-board')
    board.parent.find(string=True, recursive=False).replace_with('X5 能运行检测吗？ ')
    board.select_one('option[value=yes]').string = '可运行'
    board.select_one('option[value=no]').string = '暂不可用'
    run_note = get('#ws-route .ws-live')
    run_note.strong.string = '固定课程样张已在 X5 验证。'
    run_note.find_all(string=True, recursive=False)[0].replace_with(' A、B 使用同一张图核对检测框与标签。')
    get('#ws-route details p').string = 'A 记录本组模型来源、文件哈希和样张结果。B 记录预置模型来源、文件哈希和样张结果。C 记录观看的演示及尚未完成的内容。'

    for title, bullets in zip(get('.instructor-review').select('section'), [
        ('指出示例图上的暗部笔画和高光阶梯。', '只改 Gamma，用同一图对比前后效果。', '说出示例指数和保留或恢复的理由。'),
        ('自选一个想改善的区域和一个需保护的区域。', '用同一图和一个参数重做对照。', '说明看到的变化和自己的取舍。'),
    ]):
        for item, bullet in zip(title.select('li'), bullets):
            item.string = bullet

    get('#ws-learner > p').string = '拓展演示 · 实拍调参。确认相机和场景稳定后，可使用可写参数做实拍对照、独立回读和恢复。'
    get('#tab-learner').string = '拓展 · 实拍调参'
    get('#film-2 figcaption strong').string = '拓展 · 实拍调参实录'
    get('#film-2 figcaption p').string = '演示真实相机如何保留前后图、参数回读和恢复记录。课堂练习统一使用课程示例图。'
    get('#ws-gamma .mrg-open').append(tag('button', '看实拍调参拓展', type='button',
                                          **{'class': 'ws-control', 'data-ws-open': 'learner'}))
    get('#login-handoff > p:nth-of-type(2)').string = '登录恢复后可完成相机点亮和基线采集。两轮示例图练习可以直接在课件里做。'
    get('#ws-cards [data-sheet=prep] .todo-list li:last-child').decompose()

    evidence = get('#ws-evidence')
    get('#ws-evidence .opening-evidence').string = '实拍看相机是否点亮、能否采集基线；模型检测看固定课程样张的板端结果。'
    gallery = evidence.select_one('.checked-gallery')
    for archived in gallery.select('figure'):
        title = archived.figcaption.b.get_text(strip=True)
        if title == 'X5 BPU · 相机实时新帧':
            image_card(archived, base_capture, '原始相机画面基线采集示例',
                       '基线采集 · 原始 ISP 配置下保存的相机图像。')
        elif title == 'X5 BPU · 静态路锥已检出':
            archived.figcaption.b.string = '固定课程样张 · X5 检测结果'
            archived.button['aria-label'] = '放大固定课程样张的检测结果'
            archived.img['alt'] = '固定课程样张的 X5 检测结果'
        elif title == 'X5 BPU · Gamma 与停流回执':
            archived.decompose()
        elif title == 'Gamma 真机实操':
            archived.figcaption.b.string = '拓展 · 实拍调参档案'
    for button in evidence.select('.proof-short button[data-live-proof]'):
        button.decompose()

    wording = {
        '三张基线与启动训练': '采集基线与启动训练',
        '保存三张基线，每组启动一次训练。': '保存相机基线图，每组启动一次训练。',
        '三种基线': '三类课程用图',
        '保存三类课程用图，每组启动一次训练': '保存相机基线图，每组启动一次训练',
        '同图区对照，核对回读与取舍。': '同一张示例图对比前后，说明取舍。',
        '重载新帧与独立读回，助教预查产物。': '用同一张示例图复现选中的参数，助教查看模型进度。',
        '选出效果更好的图，重载配置并再次读取参数': '在同一张课程图上复现选中的参数',
        '固定曝光和机位。移动滑杆': '打开课程示例图。移动滑杆',
        '按模型和相机画面选择本组检测、预置检测或观看演示。': '按模型和 X5 状态选择本组检测、预置检测或观看演示。',
        '恢复原始 ISP、停流、导出成果，再请代表分享。': '确认采集已结束，保存示例图结果，再请代表分享。',
        '看证据（参数回读＋前后图）': '看前后对比（示例参数与画面）',
        '相机暂不支持调整的参数直接跳过': '实拍拓展时跳过相机不支持的参数',
        '学员验收看真机前后图、独立回读和取舍记录。': '课堂验收看同一示例图的前后效果、示例参数和取舍。',
        '助教看同机位前后新帧、独立回读与取舍；选择恢复也可签收。': '助教看相同示例图的前后对照和示例参数，请学员解释保留或恢复。',
        '助教查期初与最终读回、停流回执、两轮证据及路径。投屏看进度，原件随本组成果包保存。':
            '助教查基线图、两轮示例对照和路径结果。做过实拍拓展的组另查恢复回读。',
        '先选择相机是否出图与本组模型是否就绪。': '先选择 X5 是否能运行检测，再选择本组模型是否就绪。',
        'C · 相机暂时没有画面。': 'C · X5 暂时无法运行检测。',
        '本人检测记录': '固定课程样张的检测结果',
        '相机有画面': 'X5 可运行',
        '相机无画面': 'X5 暂不可用',
        '相机画面': 'X5 状态',
        '看模型和实时画面': '看模型和 X5 状态',
        '采集课程目标': '使用固定课程样张',
    }
    for node in soup.find_all(string=True):
        if not 0 < len(node) < 850 or node.parent.name in ('script', 'style'):
            continue
        copy = str(node)
        for before, after in wording.items():
            copy = copy.replace(before, after)
        if copy != node:
            node.replace_with(copy)
    for script in soup.select('script'):
        code = script.string or ''
        if 'function pickRoute()' in code or '当时的工位条件' in code or "if(m==='route')" in code:
            for before, after in wording.items():
                code = code.replace(before, after)
            script.string = code
        elif 'var PAGES = ' in code:
            match = re.search(r'^var PAGES = (.*);$', code, re.MULTILINE)
            pages = json.loads(match[1])
            for index in (6, 16, 17):
                pages[index-1]['title'] = get(f'#p{index} h1').get_text()
            script.string = code[:match.start(1)] + json.dumps(pages, ensure_ascii=False) + code[match.end(1):]

    draw = tag('script')
    draw.string = """(() => {
 const layer=document.createElement('canvas');
 layer.width=840; layer.height=300;
 const source=layer.getContext('2d');
 for(const canvas of document.querySelectorAll('[data-replay-gamma]')){
   const gamma=Number(canvas.dataset.replayGamma);
   window.workshopDeckImages.gamma(source,gamma);
   canvas.getContext('2d').drawImage(layer,0,36,840,264,0,0,840,264);
 }
})();"""
    soup.body.append(draw)


def refresh_preparation(soup, get, tag):
    from PIL import Image

    get('#p1 h1').string = '安装 Studio 和课堂插件'
    get('#p1 .ph .sub').string = '先安装 Studio，再导入插件。'
    setup = get('#p1 .wf-prep')
    studio_link = setup.select_one('a.lnk').extract()
    studio_link.string = '下载 RDK Studio'
    plugin_link = setup.select_one('a[download]').extract()
    setup.clear()
    setup['class'] = ['prep-cards']
    for name, info, link, screenshot, crop, detail in [
        ('RDK Studio', '安装后启动 Studio 并登录。', studio_link,
         ROOT / 'output/vision-workshop-180m-studio-20261117/Studio扩展中心.png',
         (12, 31, 304, 139), 'RDK Studio 的 AI 能力入口'),
        ('课堂相机插件', '解压 ZIP，在 Studio 的「AI → 扩展中心」选择从目录导入。', plugin_link,
         ROOT / 'output/Studio视觉Workshop-macOS现场验收/01-插件中心导入.png',
         (690, 402, 1230, 510), 'Studio 的从目录导入插件对话框'),
    ]:
        card = tag('section', **{'class': 'prep-card'})
        media = tag('div', **{'class': 'prep-media'})
        with Image.open(screenshot) as original:
            buffer = io.BytesIO()
            original.crop(crop).save(buffer, format='PNG')
        media.append(tag('img', alt=detail,
                         src='data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()))
        card.append(media)
        content = tag('div', **{'class': 'prep-card-body'})
        content.append(tag('h2', name))
        content.append(tag('p', info))
        link['class'] = ['prep-action']
        content.append(link)
        card.append(content)
        setup.append(card)

    for selector in ('#p1 .checks', '#p1 .ws-standard', '#p1 > .note'):
        get(selector).decompose()
    footer = tag('dl', **{'class': 'prep-readiness'})
    for label, info in [
        ('准备完成', 'Studio 显示插件已启用，右侧能打开课堂工作台。'),
        ('训练账号', '入口和账号由助教发放。暂未拿到时，先做相机点亮和示例图调参。'),
    ]:
        row = tag('div')
        row.append(tag('dt', label))
        row.append(tag('dd', info))
        footer.append(row)
    setup.insert_after(footer)


def lead_with_cover(soup, get):
    prep = get('#p1')
    cover = get('#p2')
    cover.select_one('.ddc-meta2').decompose()
    prep.insert_before(cover.extract())
    for number, slide in enumerate((cover, prep), 1):
        slide['id'] = f'p{number}'
        slide['data-n'] = str(number)
    prep.select_one('.pf .no').string = '2 / 19'

    for link in soup.select('[data-ws-jump="1"]'):
        link['data-ws-jump'] = '2'

    for element in soup.select('style, script'):
        code = element.string or ''
        code = re.sub(r'#p([12])\b', lambda match: f'#p{3 - int(match[1])}', code)
        if 'var PAGES = ' in code:
            match = re.search(r'^var PAGES = (.*);$', code, re.MULTILINE)
            pages = json.loads(match[1])
            pages[0], pages[1] = pages[1], pages[0]
            pages[0]['n'], pages[1]['n'] = 1, 2
            code = code[:match.start(1)] + json.dumps(pages, ensure_ascii=False) + code[match.end(1):]
            code = code.replace('var IXP = [1,', 'var IXP = [2,', 1)
        if code != (element.string or ''):
            element.string = code


def prepare(source, archive, destination, reference):
    plan_bytes = PLAN.read_bytes()
    plan = json.loads(plan_bytes)
    with ZipFile(archive) as package:
        installed_plan = package.read('rdk-camera-workshop/skills/rdk-vision-workshop/assets/course-plan.json')
        if installed_plan != plan_bytes or package.testzip() is not None:
            raise ValueError('HTML and plugin must have the same classroom plan')
    soup = BeautifulSoup(source.read_text(encoding='utf-8'), 'lxml')

    def get(selector):
        node = soup.select_one(selector)
        if not node:
            raise ValueError(f'Missing expected deck element: {selector}')
        return node

    def tag(name, text=None, **attributes):
        node = soup.new_tag(name, attrs=attributes)
        if text is not None:
            node.string = text
        return node

    table = get('#ws-time .workshop-schedule')
    table.clear()
    for stage in plan['schedule']:
        number, action = DESK[stage['id']]
        item = tag('li')
        copy = tag('div')
        topic = {'deliver': '恢复、导出与分享', 'deploy': '检测分流与模型部署'}.get(stage['id'], stage['topic'])
        copy.append(tag('strong', topic))
        copy.append(tag('small', action))
        item.append(copy)
        item.append(tag('button', '进入课件', type='button',
                        **{'class': 'ws-jump', 'data-ws-jump': str(number)}))
        table.append(item)

    get('#tab-route').string = '检测分流'
    get('#p17 .proof-tasks li:first-child b').string = '看模型是否就绪'
    get('#p17 [data-ws-open=route]').string = '打开检测分流'
    get('#p8 .launch-grid > div:nth-child(3) b').string = '每组启动一次'

    current = get('#p1 a[download]')
    candidate = tag('a', '下载 RDK Camera AI',
                    href='data:application/zip;base64,' + base64.b64encode(archive.read_bytes()).decode(),
                    download='RDK-Camera-AI.zip', **{'class': 'prep-download'})
    current.replace_with(candidate)
    get('#ws-cards [data-sheet=prep] a[download$=".zip"]').replace_with(
        tag('button', '打开插件下载页', type='button', **{'class': 'ws-jump', 'data-ws-jump': '1'}))
    get('#p1 .ws-standard').string = '验收时，Studio 显示插件已启用，右侧能打开课堂工作台。'

    primary = {'time', 'gamma', 'route', 'evidence'}
    navigation = get('.workshop-tabs')
    more = tag('details', **{'class': 'workshop-secondary'})
    more.append(tag('summary', '讲师与助教工具'))
    group = tag('div', **{'class': 'workshop-secondary-tabs'})
    for item in navigation.select('[data-ws-tab]'):
        if item['data-ws-tab'] not in primary:
            group.append(item.extract())
    more.append(group)
    navigation.insert_after(more)

    controls = next(node for node in soup.select('script') if 'panels[idx].hidden = !isActive;' in (node.string or ''))
    controls.string = controls.string.replace('tabs.forEach((button, idx) => {', 'tabs.forEach(button => {', 1).replace(
        '      panels[idx].hidden = !isActive;\n', '', 1).replace(
        '    modal.scrollTop = 0;',
        '    for (const panel of panels) panel.hidden = panel.id !== "ws-" + name;\n    modal.scrollTop = 0;', 1)

    for page, action, success in [
        (16, '到 Studio 的 ISP 面板重载选定版本。', '独立回读与选定版本一致，并拿到加载后的新帧。'),
        (17, '先按产物和工位走 A／B／C，再打开模型检测。', '新帧持续更新；另行记录目标是否连续检出。'),
    ]:
        panel = get(f'#p{page} .proof-tasks')
        help_line = tag('div', **{'class': 'workshop-action-cue'})
        for label, body in [('现在做', action), ('验收看', success)]:
            row = tag('p')
            row.append(tag('strong', label))
            row.append(tag('span', body))
            help_line.append(row)
        panel.insert(0, help_line)

    update_teaching_copy(soup, get, tag, closing_links(reference))
    remove_fixed_schedule(soup, get)
    make_instructor_deck(soup, get, tag)
    polish_instructor_pages(soup, get, tag)
    add_instructor_handoff(soup, get, tag)
    use_course_images(soup, get, tag)
    refresh_preparation(soup, get, tag)

    soup.head.append(soup.new_tag('meta', attrs={
        'name': 'workshop-plan-sha256',
        'content': hashlib.sha256(plan_bytes).hexdigest(),
    }))
    projection = tag('script')
    projection.string = """(() => {
 const menu=document.querySelector('.workshop-secondary');
 document.getElementById('workshop-dialog').addEventListener('click',event=>{
  if(event.target.closest('.workshop-tabs [data-ws-tab]')) menu.open=false;
 });
})();"""
    soup.body.append(projection)
    style = tag('style', id='shared-classroom-layout')
    style.string = """
.workshop-secondary{margin:0 -4px;padding:4px 5px 7px;color:#444963;font-size:14px}
.workshop-secondary summary{cursor:pointer;width:fit-content;font-weight:650;padding:3px 5px}
.workshop-secondary-tabs{display:flex;flex-wrap:wrap;gap:5px;padding:3px 0}
.workshop-secondary-tabs button{background:#f3f3fa;color:#303954;border:1px solid #d8dce9;border-radius:8px;padding:6px 9px;font:inherit;cursor:pointer}
.workshop-secondary-tabs button[aria-selected=true]{background:#5c4eb3;color:white}
#workshop-dialog .workshop-head{padding-bottom:2px!important}
.workshop-action-cue{border-top:3px solid #6953bd;background:#f1edfa;padding:8px 11px;border-radius:6px;margin-bottom:11px}
.workshop-action-cue p{display:grid;grid-template-columns:3.8em minmax(0,1fr);gap:7px;margin:4px 0;font-size:15px;line-height:1.35}
#p16 .proof-tasks li,#p17 .proof-tasks li{margin-bottom:9px}
#p16 .proof-standard,#p17 .proof-standard{margin:8px 0;font-size:15px}
.closing-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;padding:0;margin:12px 0 18px;counter-reset:closing;list-style:none}
.closing-steps li{border:1px solid #ddd9ef;border-top:3px solid #7156c3;border-radius:12px;background:#faf9ff;padding:17px 18px;counter-increment:closing}
.closing-steps h2{font-size:25px;display:flex;align-items:center;gap:10px;margin:0}
.closing-steps h2::before{content:counter(closing);display:grid;flex:0 0 29px;height:29px;place-items:center;border-radius:50%;background:#ece6fa;color:#4b3594;font-size:15px}
.closing-steps p{margin:12px 0;font-size:19px;line-height:1.5}
.closing-steps small{display:block;padding-top:9px;border-top:1px solid #e5e0f0;color:#4a4562;font-size:17px;line-height:1.5}
.closing-actions{display:flex;flex-wrap:wrap;gap:10px}
.closing-actions button{font-size:16px;padding:9px 12px}
.arrival-options{grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:18px}
.arrival-options section{padding:22px 18px;border:1px solid #e2dff0;background:#f7f5fd;border-radius:12px}
.arrival-options h2{font-size:25px;margin:0 0 10px}
.arrival-options p{margin:0 0 10px;font-size:20px}
.arrival-options small{display:block;font-size:18px;color:#4e4860;line-height:1.45}
.short-pipeline{display:flex;align-items:center;justify-content:space-between;gap:11px;margin-bottom:12px}
.short-pipeline ol{display:flex;flex-wrap:wrap;align-items:center;list-style:none;gap:4px 0;margin:0;padding:0}
.short-pipeline li{display:flex;align-items:center;background:#f2eefb;color:#4b3488;border-radius:6px;font-size:15px;font-weight:650;padding:5px 9px}
.short-pipeline li:not(:last-child){margin-right:20px;position:relative}
.short-pipeline li:not(:last-child)::after{content:'→';position:absolute;left:100%;width:20px;text-align:center;color:#65538b}
.short-pipeline button{white-space:nowrap}
.gamma-handoff h2{font-size:18px;color:var(--accent);margin:0 0 4px}
.gamma-handoff .handoff-question{font-size:17px;font-weight:700;color:var(--dark);margin:0 0 6px}
.gamma-handoff p{line-height:1.35}
.handoff-actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.handoff-actions button{flex:1;min-width:max-content}
.handoff-actions button[data-course-jump]{background:#5c4eb3;border-color:#5c4eb3;color:white}
.opening-evidence{margin:0 0 10px}
#p16 .example-replay{container-type:inline-size}
.replay-compare{margin:0 0 14px}
.replay-pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.replay-picture{min-width:0;overflow:hidden;border:1px solid #ded9ef;border-radius:10px;background:#f6f4fc}
.replay-label{display:flex;align-items:baseline;justify-content:space-between;gap:6px;padding:7px 11px;color:#514465;font-size:15px}
.replay-label span{font-variant-numeric:tabular-nums}
.replay-picture canvas{display:block;width:100%;height:auto;aspect-ratio:840/264}
.replay-compare figcaption{margin:6px 2px 0;color:#514b65;font-size:15px}
#p16 .proof-tasks ol{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;list-style-position:inside;padding:0}
#p16 .proof-tasks li{margin:0;padding:9px 11px;border:1px solid #e9e4f4;border-radius:9px;background:#f9f8fd;font-size:18px}
#p16 .proof-tasks li span{font-size:16px;line-height:1.4}
.replay-actions{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:12px}
.replay-actions p{margin:0;color:#514465;font-size:15px}
.replay-actions .ws-control{background:#5343a3;color:#fff;border-color:#5343a3}
#p17 .slide-proof img{height:auto;max-height:356px}
@container (max-width:600px){
 #p16 .proof-tasks ol{grid-template-columns:minmax(0,1fr);gap:6px}
 #p16 .proof-tasks li{padding:8px 10px}
 #p16 .proof-tasks li span{display:inline;margin-inline-start:.4em}
}
@container (max-width:450px){
 .replay-pair{grid-template-columns:minmax(0,1fr);gap:8px}
}
@media(min-width:701px) and (max-width:900px){
 #p17 .verified-slide{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
 #p18 .closing-steps{gap:10px}
 #p18 .closing-steps li{padding:12px}
 #p18 .closing-steps h2{font-size:20px;gap:6px}
 #p18 .closing-steps p{font-size:16px;margin:8px 0}
 #p18 .closing-steps small{font-size:14px}
}
.sample-download{display:inline-block;margin-top:5px;text-decoration:none}
#p16 figcaption,#p17 figcaption{font-size:15px;line-height:1.45}
.closing-qr{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}
.closing-qr section{text-align:center;background:#fff;border:1px solid #e2dff2;border-radius:14px;padding:18px 12px 20px}
.closing-qr button{display:block;width:min(100%,285px);margin:0 auto;padding:0;border:0;background:#fff;cursor:zoom-in}
.closing-qr img{display:block;width:100%;height:auto;aspect-ratio:1}
.closing-qr h2{font-size:21px;line-height:1.3;margin:8px 0}
.closing-qr a{color:#4f3899;display:inline-block;padding:6px 10px;font-weight:650}
.closing-qr :is(button,a):focus-visible{outline:2px solid #7356c7;outline-offset:3px}
.instructor-review{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.instructor-review section{border:1px solid #e2dff2;background:#f9f8fe;padding:12px;border-radius:10px}
.instructor-review h4{margin:0}
.instructor-review ul{padding-left:20px;margin-bottom:0}
.instructor-review li+li{margin-top:7px}
#manual-copy-text{white-space:pre-wrap;overflow-wrap:anywhere;user-select:text}
#ws-gamma .ws-decision{display:flex;justify-content:flex-start;margin-top:10px}
.gamma-rounds{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.gamma-rounds button{font:inherit;min-height:35px;padding:5px 11px;background:#f7f5fc;border:1px solid #dbd5ee;border-radius:8px;color:#413554;cursor:pointer}
.gamma-rounds [aria-pressed=true]{background:#5c4eb3;border-color:#5c4eb3;color:#fff}
.gamma-rounds button:focus-visible{outline:2px solid #5c4eb3;outline-offset:2px}
#p5 .checks label.tx{cursor:pointer;flex:1}
#p1 .prep-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
#p1 .prep-card{display:flex;flex-direction:column;overflow:hidden;border:1px solid #e7e2f2;border-radius:13px;background:#fff}
#p1 .prep-media{height:113px;display:grid;place-items:center;padding:10px 16px;background:linear-gradient(135deg,#f7f5ff,#eae6fa);border-bottom:1px solid #ebe7f7}
#p1 .prep-media img{display:block;max-width:100%;max-height:91px;object-fit:contain;border-radius:6px;box-shadow:0 4px 13px #39305d25}
#p1 .prep-card-body{display:flex;align-items:flex-start;flex-direction:column;flex:1;padding:14px 18px 16px}
#p1 .prep-card h2{margin:0 0 5px;font-size:23px;line-height:1.25}
#p1 .prep-card p{margin:0 0 11px;line-height:1.45;font-size:16px;color:#524c62;flex:1}
#p1 .prep-action{display:inline-flex;align-items:center;background:#5343a3;color:#fff;text-decoration:none;font-size:15px;font-weight:700;padding:8px 13px;border-radius:7px}
#p1 .prep-action:hover{background:#403387}
#p1 .prep-action:focus-visible{outline:2px solid #5644ab;outline-offset:3px}
#p1 .prep-readiness{margin:12px 0 0;padding:6px 14px;border-radius:9px;background:#f4f2fa}
#p1 .prep-readiness div{display:grid;grid-template-columns:6em minmax(0,1fr);align-items:baseline;gap:12px;padding:6px 0;font-size:15px}
#p1 .prep-readiness div+div{border-top:1px solid #e5e1ef}
#p1 .prep-readiness dt{font-weight:700;color:#393151}
#p1 .prep-readiness dd{margin:0;color:#524c62}
#bar button.icon svg,#bar #ov svg{width:19px;height:19px;stroke-width:1.85;stroke-linecap:round;stroke-linejoin:round}
#bar button:focus-visible{outline:2px solid #d8c6ff;outline-offset:2px}
.mrg-agenda li{grid-template-columns:46px 220px minmax(0,1fr)}
#ws-time .workshop-schedule li{grid-template-columns:minmax(0,1fr) auto}
#bar #pos,#bar #pos b{color:#4f4b63}
.toolbar-short{display:none}
@media(max-width:650px){
 .closing-steps{grid-template-columns:minmax(0,1fr);gap:10px}
 .closing-steps li{padding:12px 14px}
 .closing-steps h2{font-size:22px}
 .closing-steps p{margin:7px 0;font-size:17px}
 .closing-steps small{font-size:15px}
 .arrival-options{grid-template-columns:minmax(0,1fr);gap:9px}
 .arrival-options section{padding:12px}
 .arrival-options h2{font-size:18px}
 .arrival-options p{font-size:16px;margin-bottom:5px}
 .arrival-options small{font-size:15px}
 .short-pipeline{align-items:flex-start;flex-direction:column;gap:6px}
 .short-pipeline li{font-size:13px;padding:4px 6px}
 .gamma-handoff .handoff-question{font-size:16px}
 .handoff-actions button{min-height:35px}
 .closing-qr{grid-template-columns:1fr;gap:12px}
 .closing-qr section{padding:12px}
 .closing-qr button{width:min(75%,250px)}
 .closing-qr h2{font-size:18px}
 .instructor-review{grid-template-columns:1fr}
 .gamma-rounds button{min-height:40px}
 #side.hide{transition:none;pointer-events:none}
 #p1 .prep-cards{gap:10px}
 #p1 .prep-card-body{padding:11px}
 #p1 .prep-card h2{font-size:20px}
 #p1 .prep-card p{font-size:15px}
 #p1 .prep-readiness div{grid-template-columns:5em minmax(0,1fr);gap:6px}
 #bar{gap:4px}
 #bar #ov{width:34px;padding:0;justify-content:center}
 #bar #ov span{display:none}
 #bar .toolbar-long{display:none}
 #bar .toolbar-short{display:inline}
 .mrg-agenda li{grid-template-columns:36px minmax(0,1fr);gap:4px 8px}
 .mrg-agenda .d{grid-column:2}
 #bar:has(#mode [data-mode=read].on) #fs{display:none}
}
@media(max-width:650px){.workshop-secondary{font-size:13px}.workshop-action-cue p{grid-template-columns:3.5em minmax(0,1fr)}}
"""
    style.string += """
@media(max-width:530px){
 #p1 .prep-cards{grid-template-columns:minmax(0,1fr)}
 #p1 .prep-media{height:94px}
 #p1 .prep-media img{max-height:74px}
 #p1 .prep-action{min-height:40px}
}
"""
    soup.head.append(style)
    lead_with_cover(soup, get)
    destination.write_text(str(soup), encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('plugin', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--closing-reference', required=True, type=Path)
    args = parser.parse_args()
    prepare(args.source, args.plugin, args.output, args.closing_reference)
