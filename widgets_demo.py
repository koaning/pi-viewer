# /// script
# dependencies = [
#     "anywidget==0.11.0",
#     "marimo",
#     "traitlets==5.16.1",
# ]
# requires-python = ">=3.15"
# ///

import marimo

__generated_with = "0.26.0"
app = marimo.App(sql_output="polars")


@app.cell
def _():
    import marimo as mo

    slider = mo.ui.slider(1, 100, value=25, label="Pick a number")
    dropdown = mo.ui.dropdown(["apples", "bananas", "cherries"], label="Favorite fruit")
    text = mo.ui.text(placeholder="Type something...", label="Your name")
    checkbox = mo.ui.checkbox(label="Enable magic mode")
    mo.vstack([slider, dropdown, text, checkbox])
    return checkbox, dropdown, slider, text


@app.cell(hide_code=True)
def _(checkbox, dropdown, slider, text):
    # Widgets are reactive: this cell re-runs whenever a widget value changes
    fruit = dropdown.value
    n = slider.value
    if checkbox.value:
        print(f"✨ Magic: {n} {fruit} for {text.value or 'you'}!")
    else:
        print(f"Plain and simple: {n} {fruit}")


@app.cell(hide_code=True)
def _():
    import anywidget
    import traitlets

    class CounterWidget(anywidget.AnyWidget):
        _esm = """
        function render({ model, el }) {
          let btn = document.createElement("button");
          btn.className = "counter-btn";
          btn.style.padding = "10px 20px";
          btn.style.fontSize = "16px";
          let update = () => (btn.textContent = `count: ${model.get("count")}`);
          btn.addEventListener("click", () => {
            model.set("count", model.get("count") + 1);
            model.save_changes();
          });
          model.on("change:count", update);
          update();
          el.appendChild(btn);
        }
        export default { render };
        """
        count = traitlets.Int(0).tag(sync=True)

    CounterWidget()


if __name__ == "__main__":
    app.run()
