// Modules
const PlanningAlgorithm = require("./planning-algorithm");

// Libraries
const moment = require("moment");

// Settings
const planning_settings = require("../../config/planning-settings.json");
const first_categ_name = "Поклейка";


module.exports = class PlanningPackagesAlgorithm extends PlanningAlgorithm {
    constructor(plans, dataset) {
        super(plans, dataset);
        
        this.plan_without_end_date = false;

        // = Extend object of functions for first category =
        // Check first category planning results
        this.functions_for_first_categ.helpersFunctions.checkPlanningResults = () => {
            // Planned completely
            if (
                !this.plans[this.first_categ_ind].managers_options?.[this.manager_id]?.[this.card_number]?.rest ||
                this.already_planned_processes_counter
            ) return this.dataset.client_data.plan_forcibly = true;
    
            // Planned partly
            if (this.planning_mode == "light") {
                if (
                    this.dataset.client_data.choose_second_end_date !== undefined ||
                    this.dataset.client_data.choose_other_end_date === false
                ) return; // Available only choose other modes
    
                this.plan_without_end_date = true;
    
                if (this.dataset.client_data.choose_other_end_date)
                    this.found_other_end_date_again = true;
            } else if (this.planning_mode == "hard") { // Last planning mode
                this.functions_for_first_categ.callAlgorithmWithAdditonalParams.planByForceMajeure();
            }
        }
        // ====
    }


    // Check if day is off
    checkDayOff(active_pl_date) {
        let current_month = moment.utc(active_pl_date).format("MMMM");
        return this.plans_general_settings.weekends_calendar[current_month][moment.utc(active_pl_date).format("YYYY-MM-DD")].is_day_off;
    }
    

    // Define last plan date for the first category
    lastPlanDateForFirstCategory() {
        let last_plan_date = moment.utc(this.dataset.card_data.workProperties.endDateDB)
        .subtract(planning_settings.planning_modes[this.planning_mode].days_until_end_date, "days").toDate();

        return this.defineLastPlanDateAsWeekday(last_plan_date);
    }

    
    // Call plan single func for the first category
    callPlanFirstCategory() {
        for (let i = 0; i < this.plans.length; i++) {
            if (this.plans[i].category !== this.first_category) continue;

            this.first_categ_ind = i;

            this.functions_for_first_categ.helpersFunctions.replaceEndDateDB();
            
            let dates_obj = {
                beginning_plan_date: this.defineBeginningDateForCategoryPlanning(this.planning_mode), // string
                last_plan_date: this.lastPlanDateForFirstCategory().format("YYYY-MM-DD") // string
            }

            if (this.dataset.not_plan_assembly) {
                if (this.dataset.client_data.plan_forcibly) {
                    if (!this.planSingleCategory(this.plans[i], dates_obj, this.planning_mode, { not_plan_category: true })) {
                        this.functions_for_first_categ.callAlgorithmWithAdditonalParams.planByForceMajeure();
                    }
                } else {
                    this.planning_failed_msg = "Поклейка уже была выполнена. Все равно запланировать техкарту?";
                    this.additional_failed_obj = {
                        params: this.dataset.client_data,
                        type: "already performed assembly",
                        not_completely_planned: true
                    };
                }

                break;
            }
            
            // Beginning date > than last
            if (!this.planSingleCategory(this.plans[i], dates_obj, this.planning_mode)) {
                // Plan forcibly
                if (this.dataset.client_data.choose_other_end_date === false) 
                    this.functions_for_first_categ.callAlgorithmWithAdditonalParams.planByForceMajeure();
                else // Find other end date
                    this.functions_for_first_categ.callAlgorithmWithAdditonalParams.planWithoutEndDate(true);
                break;
            }

            this.functions_for_first_categ.helpersFunctions.checkPlanningResults();
        }
    }


    // Call plan single func for other categories (not first)
    callPlanOthersCategories() {
        if (this.planning_failed_msg) 
            return this.planning_failed_msg;
      
        if (this.not_plan_other_categories) return;
        
        if (this.plans.length > 1) {
            for (let i = 0; i < this.plans.length; i++) {
                if (i == this.first_categ_ind) continue;

                let last_plan_date = moment.utc(this.plans[this.first_categ_ind].managers_options[this.manager_id]
                ?.[this.card_number]?.last_planned_date) || this.lastPlanDateForFirstCategory(); // moment object

                let today_date = moment.utc().startOf("day").toDate();

                // In the past tense (imposible only if admin has already planned [partly or completely] first process)
                if (last_plan_date.toDate() - today_date < 0) {
                    this.planning_failed_msg = "Невозможно запланировать техкарту, так как последняя планированная дата" + 
                    " " +  "первого процесса в прошедшем времени";
                    break;
                }

                let dates_obj = {}
                
                // For the last category beginning date is last planned date by previous category (if it's not assembly)
                if (i + 1 == this.plans.length && this.plans[i - 1].category !== first_categ_name) {
                    let last_planned_date_of_prev_categ;

                    let dates_arr = Object.keys(this.plans[i - 1].plan_data);

                    for (let d = 0; d < dates_arr.length; d++) {
                        if (!this.plans[i - 1].plan_data[dates_arr[d]][this.card_number]) continue;
                        
                        last_planned_date_of_prev_categ = dates_arr[d];
                    }

                    if (!last_planned_date_of_prev_categ)
                        last_planned_date_of_prev_categ = this.defineBeginningDateForCategoryPlanning(this.planning_mode);

                    if (new Date(last_planned_date_of_prev_categ || 0) - today_date < 0) {
                        this.planning_failed_msg = "Невозможно запланировать техкарту, так как последняя планированная дата" + 
                        " " +  `процесса "${this.plans[i - 1].category}" в прошедшем времени`;
                        break;
                    }

                    dates_obj.beginning_plan_date = last_planned_date_of_prev_categ; // string
                } else {
                    dates_obj.beginning_plan_date = this.defineBeginningDateForCategoryPlanning(this.planning_mode); // string
                }

                dates_obj.last_plan_date = last_plan_date.format("YYYY-MM-DD") // string

                dates_obj.beginning_plan_date = last_plan_date.toDate() < new Date(dates_obj.beginning_plan_date) ?
                    dates_obj.last_plan_date: // processes was planned by admin
                    dates_obj.beginning_plan_date;

                this.planSingleCategory(this.plans[i], dates_obj, this.planning_mode);
            }
                
            if (this.planning_failed_msg) 
                return this.planning_failed_msg;
        } 
        
        // Plan without end date after planning all categories
        if (this.plan_without_end_date) 
            this.functions_for_first_categ.callAlgorithmWithAdditonalParams.planWithoutEndDate();
    }


    // = Plan single category functions =
    // Define last plan date when circulation <= 0
    defineLastPlanDateWithNonCirculation(plan, last_plan_date, options) {
        if (!options?.copied_data)
            this.already_planned_processes_counter += 1;
        
        if (plan.category !== this.first_category) 
            return last_plan_date;
    
        for (let day in plan.plan_data) {
            if (!plan.plan_data[day][this.card_number]) continue;

            last_plan_date = day;
            break;
        }
    
        return last_plan_date; // string: format(YYYY-MM-DD)
    }


    // Define beginning date
    defineBeginningDateForCategoryPlanning(pl_mode_name) {
        return moment.utc(this.beginning_plan_date)
        .add(planning_settings.planning_modes[pl_mode_name].days_after_beginning, "days").format("YYYY-MM-DD");
    }
    // ====
}