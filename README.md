# grid-button-card

### 一个为Homeassistant Dashboard设计的自定义卡片
#### Grid Button Card 是一个高度可定制的 Lovelace 卡片，它允许您在一个卡片内创建灵活的按钮网格布局。
#### 其核心特色是 “飞行高亮” (Flying Highlight) 效果：当卡片的某个状态激活时，一个独立的高亮层会以平滑的动画效果，从上一个激活的按钮“飞”到当前激活的按钮上。适用于switch、select等选项互斥的实体


主要特性：
- 动态网格布局：通过 CSS Grid 自由定义按钮的排列、大小和间距。
- 飞行高亮效果：根据实体状态自动、平滑地移动高亮层。
- 乐观更新：点击按钮后，高亮层会立即移动到目标位置，提供即时反馈，无需等待后端状态更新。
- 丰富的样式定制：卡片、按钮、图标、文本等几乎所有元素的样式都可以通过 YAML 进行深度定制。
- 模板支持：所有内容和大部分样式都支持js模板语法 ([[[...]]]），可以实现完全动态的卡片。
- 标准动作：支持 call-service, navigate, toggle 等所有标准的 Home Assistant 点击动作。

#### 此项目全部功能实现代码由AI生成 Power By ChatGPT
---
### 预览：
![](https://github.com/gasment/grid-button-card/blob/main/preview1.webp)
![](https://github.com/gasment/grid-button-card/blob/main/preview2.webp)
- switch实体用例
- ![](https://github.com/gasment/grid-button-card/blob/main/preview3.webp)
- select实体用例
- ![](https://github.com/gasment/grid-button-card/blob/main/preview4.webp)
### 安装说明：
复制本项目仓库地址：https://github.com/gasment/grid-button-card ,在HACS添加Custom repositories，Repositories填写仓库地址，Type选择Dashboard； 搜索：grid-button-card，下载安装，按提示刷新页面

## 配置说明
### 顶层配置
| yaml配置项 | 效果说明 | 使用说明 | 配置示例 |
| --- | --- | --- | --- |
| `type` | 声明卡片类型 |  ​**必需**，固定为 `custom:grid-button-card` | `type: custom:grid-button-card`
| `sync_state` | 驱动高亮层移动的状态源。它的计算结果将与各按钮的 sync_state 值进行比较。 | ​**必需**，通常设置为一个能代表当前活动状态的模板，如 [[[ return states['select.my_entity'].state; ]]] | 见下文`sync_state`部分 |
|`variables`|变量功能，可在卡片js模板中读取与复用|可选，变量支持js模板动态取值|见下文`variables`部分|
| `sync_state_delay` | 乐观更新的回滚延迟时间（毫秒）。点击后，高亮层会立即移动，如果在这段时间内 sync_state 未能更新到目标值，高亮层将返回原位。| 可选，默认值1000ms，可根据实体响应速度微调 | `sync_state_delay: 500` |
| `button_grid` | 定义了所有按钮的布局名称和具体配置 | 必需。键名（如 button1）必须与 styles.grid 中 grid-template-areas 定义的区域名对应。| 见下文`button_grid`部分 |
| `styles` | 定义卡片顶层容器的样式 | 可选。一个 CSS 样式对象数组。| 见下文`styles`部分 |

### JS表达式写法
- 基本与button-card一致
- 分行符使用“|”、“>-”，另起一行使用[[[···]]]包裹js代码
- 读取实体主属性使用：states[`your_entity_id`].state
- 读取实体附加属性使用：states[`your_entity_id`].attributes.xxxxx
- 可以使用变量代替实体id: states[`${variables.your_entity_id}`].state
- 支持赋值变量var/cont/let,支持if else 多行嵌套
- 使用return返回数值
- 示例：
    ```
    button_effect_color: |
        [[[
            var state = states[`sensor.entity`].state
            if (state === "off"){
            return "#D7DFED"
            } else if (state === "cool"){
            return "#2483FF"
            } else if (state === "heat"){
            return "#FF6B6B"
            } else if (state === "dry"){
            return "#54CEAE"
            } else if (state === "fan_only"){
            return "#4CCBA9"
            } else if (state === "auto"){
            return "#464BD8"
            } else {
            return "#D7DFED"
            }
        ]]]
    ```
### varibales用法
- 支持多个变量定义，每个变量支持静态或动态js模板
  ```
  variables:
    example_1: 114514
    example_2: |
        [[[
          var value = states[`light.entity`].state;
          if (value === "on"){
            return "打开"
          } else {
              return "关闭"
          }
        ]]]
    example_3: switch.my_switch
  ```
- 在卡片内使用变量：
  ```
  name: |
    [[[return variables.example_1]]]
  state: |
    [[[
      var value = states[`${variables.example_3}`].state;
      if (value === "on"){
        return "打开"
      } else {
          return "关闭"
      }
    ]]]
  ```
### sync_state配置
- sync_state存在于两个地方，第一个是顶层的sync_state，另一个是button_grid.<button-grid-name>.sync_state，当button_grid.<button-grid-name>.sync_state = 顶层sync_state时，该button_grid就会被应用高亮动画
- 顶层sync_state配置：
    ```
    #可直接返回实体状态
    sync_state: |
        [[[return states[`your_entity_id`].state]]]
    #或使用条件判断
    sync_state: |
        [[[
            var value = states[`your_entity_id`].state
            if (value < 100){
                return "on"
            } else {
                return "off"
            }
        ]]]
    ```
- button_grid内的sync_state配置，此处通常配置为静态字符串，当此值与顶层的sync_state相同时，按钮就会被点亮
    ```
    button_grid:
      button1:
        sync_state: on
    ```
### 顶层styles配置
- 顶层的styles配置用于卡片顶层容器和按钮布局样式，支持`card`和`grid`入口
- `card`，用于卡片顶层容器css样式
    ```
    styles：
      card:
        - padding: 5px
        - border-radius: 20px
        - background: rgba(0,0,0,0)
    ```
- `grid`，用于配置按钮布局样式
    | 子配置 | 效果说明 | 使用说明 | 配置示例 |
    | --- | --- | --- | --- |
    | grid-template-areas |  配置按钮的网格布局 |  **必需** ，area名称必须与button_grid下的一致 | 见下文`styles -> grid`详情 |
    | grid-template-columns | 配置网格的列宽| 可选，支持px/%/fr等常见数值 | 见下文`styles -> grid`详情 |
    | grid-template-rows | 配置网格的行高 | 可选，支持px/%/fr等常见数值 | 见下文`styles -> grid`详情 |
    | column-gap | 配置网格列间距| 可选，支持px/%/fr等常见数值 | `column-gap: 10px`|
    | row-gap | 配置网格行间距| 可选，支持px/%/fr等常见数值 | `row-gap: 10px`|
    | justify-items/justify-content | 配置网格、网格内容的水平对齐方式| 可选，支持start/center/end|`justify-items: center`|
    | align-items/align-content | 配置网格、网格内容的垂直对齐方式| 可选，支持start/center/end|`align-items: center`|
### 顶层styles -> grid配置
- grid-template-areas配置，示例一个3 x 2的布局(button1/2/3/4/5/6只是示例名称，可自定义，但是必需与button_grid的子对象一致)
    ```
    styles:
      grid:
        - grid-template-areas: |
            "button1 button2 button3"
            "button4 button5 button6"
    ```
- grid-template-columns，网格的列宽配置，按上面3x2示例，从左到右分别定义每列的宽度
    ```
    styles:
      grid:
        - grid-template-columns: 50px auto 100px
    ```
- grid-template-rows，网格的行高配置，按上面3x2示例，从上到下分别定义每行的高度
    ```
    styles:
      grid:
        - grid-template-rows: 50% 50%
    ```
### button_grid 配置
| 配置项 | 效果说明 | 使用说明 | 配置示例 |
| --- | --- | --- | --- |
| name | 按钮的名称文本 | 可选，支持模板和字符串 | `name: example` |
| label | 按钮的标签文本 | 可选，支持模板和字符串 | `label: example` |
| state | 按钮的状态文本 | 可选，支持模板和字符串 | `state: example` |
| icon | 按钮的图标 | 可选。可以是 mdi:xxxx 或一个图片URL。支持模板 | `icon: mdi:lightbulb` |
| sync_state | 此按钮对应的状态值。当顶层的 sync_state 计算结果与此值相等时，此按钮将被高亮 | **必需**。通常为字符串 | 参考上文sync_state配置 |
| sync_button_highlight | 定义当此按钮被高亮时，高亮层的背景颜色 | 可选，接受任何 CSS 颜色值，如 '#FF5722' 或 'rgba(255, 87, 34, 0.3)'。如果省略，会使用一个默认的蓝色 | `sync_button_highlight: blue` |
| tap_action | 此按钮的点击动作 | 可选，写法与ha开发者选项中的动作yaml配置一致 | 见下文`tap_action`配置 |
| styles | 定义此按钮及其内部元素的样式 | 可选。一个 CSS 样式对象数组。 | 见下文`button_grid -> styles`配置 |

### tap_action 配置示例
- 更多可配置项，可前往ha开发者选项的动作页面，摘抄yaml配置
- 开关切换：
    ```
    tap_action:
      action: toggle
      target:
        entity_id: <your_switch_entity_id>
    ```
- 灯打开、关闭、切换开关
    ```
    tap_action:
      action: light.turn_on / light.turn_off / toggle
      target:
        entity_id: <your_light_entity_id>
    ```
- 选项选择：
    ```
    tap_action:
      action: select.option
      target:
        entity_id: <your_select_entity_id>
      data:
        option: <option_name>
    ```
### button_grid -> styles 配置示例
| 配置项 | 效果说明 | 使用说明 |
| --- | --- | --- |
|card|作用于该按钮的背景层|可以设置 background、border-radius 等|
|grid|作用于按钮内部承载 icon/name 等元素的网格容器|仅支持设置areas为name/state/icon/label,不支持自定义|
|name/state/label|分别作用于按钮的名称、状态和标签文本元素|可以设置 font-size、color、justify-self、align-self 等|
|icon|分别作用于按钮的图标元素|可以设置 height、width 等|
- 配置示例：
  ```
  button_grid:
    button1:
      styles:
        card:
          - background-color: 'rgba(120, 120, 120, 0.15)'
        grid: 
          - grid-template-areas: 
                  "icon name"
                  "icon state"
          - grid-template-rows: auto auto
          - grid-template-columns: 50% 50%
          - align-content: center
        icon:
          - color: green
          - height: 20px
          - width: 20px
        name:
          - font-size: 16px
          - letter-spacing: 5px
        state:
          - font-size: 12px
          - color: white     
  ```

### 完整配置示例
```
type: custom:grid-button-card
sync_state: |
  [[[
        var value = states[`your_entity_id`].state
        if (value < 100){
            return "on"
        } else {
            return "off"
        }
   ]]]
sync_state_delay: 800
styles:
  card:
    - background-color: 'rgba(50, 50, 50, 0.1)'
    - border-radius: '16px'
    - padding: '8px'
  grid:
    - grid-template-areas: |
        "button1 button2"
    - grid-template-columns: auto auto
    - grid-template-rows: 50% 50%
    - gap: 8px

button_grid:
  button1:
    name: 按钮1
    sync_state: on
    state: |
      [[[ return states[`your_entity_id`].state ]]]
    icon: /local/icon/your_on_icon.svg
    tap_action:
      action: switch.turn_off
      target:
        entity_id: <your_entity_id>
    styles:
      card:
        - background-color: 'rgba(120, 120, 120, 0.15)'
      grid: 
        - grid-template-areas: 
                "icon name"
                "icon state"
        - grid-template-rows: 50% 50%
        - grid-template-columns: 50px auto
      icon:
        - color: rgb(36,62,186)
        - height: 30px
        - width: 30px
      name:
        - font-size: 16px
        - color: black
      state:
        - font-size: 12px
        - color: white
        - align-self: start

  button2:
    name: 按钮2
    sync_state: off
    state: |
      [[[ return states[`your_entity_id`].state ]]]
    icon: /local/icon/your_off_icon.svg
    tap_action:
      action: switch.turn_off
      target:
        entity_id: <your_entity_id>
    styles:
      card:
        - background-color: 'rgba(120, 120, 120, 0.15)'
      grid: 
        - grid-template-areas: 
                "icon name"
                "icon state"
        - grid-template-rows: 50% 50%
        - grid-template-columns: 50px auto
      icon:
        - color: rgb(36,62,186)
        - height: 30px
        - width: 30px
      name:
        - font-size: 16px
        - color: black
      state:
        - font-size: 12px
        - color: white
        - align-self: start

```
