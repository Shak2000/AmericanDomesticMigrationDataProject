import enrich_county_data
import enrich_state_data
import parse_fips
import validate_data


def main():
    parse_fips.main()
    enrich_state_data.main()
    enrich_county_data.main()
    validate_data.main()

if __name__ == "__main__":
    main()
