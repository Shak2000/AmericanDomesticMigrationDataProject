Purpose: Create an interactive data visualization that displays IRS data on U.S. domestic migration over time.

Data source: IRS SOI tax data - Migration data and FCC FIPS Codes for States and Counties

Data to display:

- Population inflow
- Population outflow
- Net population flow
- Population inflow as a share of population
- Population outflow as a share of population
- Net population flow as a share of population
- Households inflow
- Households outflow
- Net household flow
- Households inflow as a share of households
- Households outflow as a share of households
- Net household flow as a share of households
- AGI inflow
- AGI outflow
- Net AGI flow
- AGI inflow as a share of AGI
- AGI outflow as a share of AGI
- Net AGI flow as a share of AGI
- Average AGI of individual moving in
- Average AGI of household moving in
- Average AGI of individual moving out
- Average AGI of household moving out

What to include in the display:

- A large map, where it should be possible to select a primary state or county and a secondary state or county
- A smaller line graph
- A radio button pair for choosing between state and county
- A slider for choosing the year a dropdown for the data to display in general

How to display the map:

- On the map, it should be possible to select and unselect a primary and secondary state or county with the click of a button.
- If no state or county is selected, then show the total flow to or from each state or county.
- If a primary state or county is selected, then show the flow between one state or county and every other state or county.

How to display the line graph:

- If a primary state or county is not selected, then do not display anything.
- If a primary state or county is selected, but a secondary state or county is not, then next to the graph, enable a dropdown for selecting whether to display one of the following, and display it over the course of all the years for which there is data:
    - Total flow
    - Total U.S. flow
    - Total foreign flow
    - Total same-state flow
    - Total different-state flow (county only)
    - Total non-movers
- If both a primary and a secondary state or county are selected, then display the data for the flow between the states or counties over the course of all the years for which there is data.

Code to use to display the data: index.html, styles.css, and script.js

Data modifications:

- Write a Python program to convert fips.txt into 2 CSV files: one for state FIPS, and another for county FIPS.
- Write a Python program to create new state CSV data files, which add data columns for:
    - The missing state postal code
    - The missing state name
- Write a Python program to create new county CSV data files, which add data columns for:
    - The missing state postal code
    - The missing state name

Data notes:

- In the original state and county CSV data files:
    - y1 refers to the receiving state.
    - y2 refers to the sending state.
    - n1 refers to the number of households.
    - n2 refers to the number of individuals.
- When writing the Python programs to create new state and county CSV data files, please use abstraction to write two general-purpose Python programs: one for state data and one for county data.
